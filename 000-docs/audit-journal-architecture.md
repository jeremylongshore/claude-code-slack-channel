# Audit Journal Architecture

Design reference for the journal sink named in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) and implemented by **Epic 30-A**
(ccsc-5pi) for v0.4.1 and Epic 30-B for v0.5.0+. This document fixes the
append format, hash-chain semantics, redaction rules, and verification
command before any code lands, so 30-A PRs can be reviewed against a frozen
record format.

The audit journal is the **only** component that sees every
security-relevant event the plugin handles: inbound gate drops, outbound
gate refusals, policy decisions, session transitions, exfil-guard hits,
pairing events. Losing the journal loses the post-hoc forensic surface —
so the journal is write-once, append-only, hash-chained, and careful about
what it stores.

---

## JournalEvent schema

```ts
interface JournalEvent {
  v:        1                              // schema version; bump on incompatible change
  ts:       string                         // ISO-8601 UTC with ms precision; monotonic counter disambiguates ties
  seq:      number                         // monotonic per-process; never resets within a chain
  kind:     EventKind                      // see table below
  toolName?:string                         // when kind involves a tool call
  input?:   Record<string, unknown>        // redacted tool-call args
  outcome?: 'allow' | 'deny' | 'require' | 'drop' | 'n/a'
  reason?:  string                         // short, human-readable; no PII, no secrets
  ruleId?:  string                         // for policy decisions
  sessionKey?: { channel: string; thread: string }
  actor?:   'session_owner' | 'claude_process' | 'human_approver' | 'peer_agent' | 'system'
  correlationId?: string                   // links related events (Dapper-style)
  prevHash: string                         // sha256 hex of the previous event's serialized form
  hash:     string                         // sha256 hex of (prevHash || canonicalJson(event_without_hash))
}

type EventKind =
  | 'gate.inbound.deliver'
  | 'gate.inbound.drop'
  | 'gate.outbound.allow'
  | 'gate.outbound.deny'
  | 'policy.allow'
  | 'policy.deny'
  | 'policy.require'
  | 'policy.approved'
  | 'exfil.block'
  | 'session.activate'
  | 'session.quiesce'
  | 'session.deactivate'
  | 'session.quarantine'
  | 'pairing.issued'
  | 'pairing.accepted'
  | 'pairing.expired'
  | 'system.boot'
  | 'system.shutdown'
  | 'system.reload'
```

Three cuts worth highlighting:

- **`v: 1`** is the only way we'll ever introduce an incompatible shape.
  Verification tools refuse mixed versions in one chain.
- **`seq`** lets us detect dropped writes even when `ts` collisions are
  within clock resolution. A missing `seq` between two events is a
  tamper signal during verification.
- **`correlationId`** is the Dapper-style thread that links, e.g., a
  single tool call's `policy.require` → `pairing.issued` →
  `pairing.accepted` → `policy.approved` → `gate.outbound.allow`.
  Sampling of correlated event chains is what makes the journal useful
  under volume.

---

## Hash chain (Schneier & Kelsey, 1999)

```
hash_n = sha256(hash_{n-1} || canonical_json(event_n without 'hash'))
hash_0 = sha256(TRUSTED_ANCHOR)
```

`TRUSTED_ANCHOR` is a per-chain random value written as the payload of the
very first `system.boot` event. The anchor is part of the event body, so
it cannot be forged without discovering it from the journal itself.

**Why SHA-256, not an HMAC?** An HMAC would require a key accessible to
the writer and to the verifier. The writer is the same process that wrote
every event, and the verifier is a separate tool run by a human — sharing
a key between them is fragile. The chain property (any edit breaks the
next hash) is enough for tamper detection; post-fact confidentiality of
the journal is not what we're after.

`canonicalJson()` is the standard JCS (RFC 8785) form so two independent
implementations compute the same hash.

### What tampering does and does not detect

Detects:

- Edit of any event's body → `hash` no longer matches → verify fails at
  that event.
- Reorder of any two events → `prevHash` chain breaks.
- Insertion of a forged event → `prevHash` of the event after insertion
  mismatches.

Does **not** detect:

- **Truncation of the tail** (the last N events deleted). Nothing in
  events 1..N-M-1 points forward to N-M..N, so the chain is valid up to
  where it stops. Mitigations:
  - External log forwarding (Epic 30-B) — tail is mirrored off-host.
  - Trusted-anchor publication — periodically, the latest `(seq, hash)`
    pair is written to a second sink (e.g., a pinned gist or a syslog
    receiver) so a truncation leaves the anchor dangling.
- **Complete journal deletion** — out of scope; at that point the
  attacker has filesystem control and the journal is the wrong layer.

---

## Write path (sequence diagram)

```mermaid
sequenceDiagram
    autonumber
    participant CALL as Caller<br/>(gate / policy / session)
    participant RED as Redactor
    participant WR as Journal writer
    participant FS as audit.log (O_APPEND, 0o600)
    participant TAIL as Tail anchor<br/>(Epic 30-B)

    CALL->>WR: writeEvent(partial)
    WR->>RED: redact(partial.input, partial.reason)
    RED-->>WR: partial' (tokens replaced with [REDACTED:kind])
    WR->>WR: partial'.seq  = ++seq
    WR->>WR: partial'.ts   = nowIso()
    WR->>WR: partial'.prevHash = lastHash
    WR->>WR: partial'.hash = sha256(lastHash || jcs(partial' sans hash))
    WR->>FS: fs.write(fd, JSON + "\n")
    Note over FS: O_APPEND — writes land atomically<br/>at end of file, one JSON per line.
    WR->>WR: lastHash = partial'.hash
    opt External mirror (30-B)
        WR--)TAIL: publish (seq, hash)
    end
    WR-->>CALL: ok | error
```

The writer is a single struct (`JournalWriter`) with a mutex around the
increment-hash-write block. All callers serialize through it — the
order of operations matters, and re-entrancy would be a footgun. There
is exactly one `JournalWriter` per process.

File handling:

- Opened once at boot with `O_APPEND | O_WRONLY | O_CREAT`, mode `0o600`.
- `O_APPEND` means concurrent writers on POSIX append atomically; we
  still serialize for the hash chain, not for write safety.
- On rotation signal (Epic 30-B), writer closes and reopens; the
  *new* file begins with a `system.reload` event whose `prevHash` is
  the last hash of the previous file — cross-file chain continuity.

---

## Redaction

Run *before* the event is hashed or written.

```ts
const TOKEN_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'anthropic',  re: /sk-[a-zA-Z0-9-]{20,}/g },
  { kind: 'slack_bot',  re: /xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/g },
  { kind: 'slack_app',  re: /xapp-[0-9]+-[A-Z0-9]+-[0-9]+-[a-f0-9]+/g },
  { kind: 'github',     re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { kind: 'aws_access', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'jwt',        re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
]

function redact(v: unknown): unknown {
  // Deep-walk; replace each match with `[REDACTED:${kind}]`.
}
```

Applied to `input`, `reason`, and any nested string. Not applied to
top-level typed fields (`ts`, `seq`, `kind`, `hash`, …) — those never
carry secrets.

**What redaction does not do:**

- Does not guard against bespoke secrets (internal tokens, user
  messages that contain passwords). The operator is told explicitly
  that the journal may contain message content and must be stored at
  `0o600`.
- Does not claim fitness for compliance frameworks. This is a forensic
  record for one developer, not a SOC 2 audit trail.

**What redaction adds to the hash.** The redacted form is what's hashed,
because that's what ends up on disk. A verifier working from a copy of
the file cannot recover redacted tokens from the hash.

---

## Truncation

Long string values are truncated to a hard limit (default 2048 chars
per field) with a marker `[... truncated 12345 chars]` so the record
stays bounded. Truncation happens after redaction, so a half-truncated
token never appears on disk.

The original length is preserved in a sibling field (`<field>.len`) so
forensics can tell when a payload was large without seeing it.

---

## Projection to Slack (Epic 30-B, not 30-A)

In v0.4.1 the journal is **local only**. The `--audit-log-file` CLI flag
and `SLACK_AUDIT_LOG` env var set the destination; there is zero Slack
surface.

In v0.5.0+ a separate projection component reads the local journal and
forwards a filtered subset to an `#audit` channel, subject to the
outbound gate. The projection is explicitly *not* the source of truth
— the source of truth stays on disk, hash-chained, operator-owned.

Why separate the projection?

1. **The local log must survive Slack being unreachable.** If Slack is
   down, we still want the journal.
2. **The projection filters** — not every event makes sense in a chat
   channel. Filtering belongs in a dedicated transform, not muddled
   into the writer.
3. **The projection can be disabled** without losing anything; the
   journal is primary.

---

## Verification command

Epic 30-A ships `verifyJournal(path)` as an exported function from
`journal.ts`. Behavior:

1. Read the file line-by-line, parse each as JSON.
2. Reject if schema versions differ or the event fails strict
   `JournalEvent` validation.
3. For each event, recompute
   `expected = sha256(prevHash || jcs(event sans hash))` and compare.
4. On any break, return a `VerifyResult` with `ok: false` and a
   `break` describing `lineNumber`, `seq`, `ts`, `reason`, and — when
   applicable — `expected` / `actual` hashes. The function never
   modifies the file.
5. On success return `{ ok: true, eventsVerified: N }`.

### Example 3-line log

A minimal intact chain — each `prevHash` equals the previous event's
`hash`, and `seq` increments by one. (Hashes truncated for
readability; real entries are 64-char hex.)

```jsonl
{"v":1,"seq":1,"ts":"2026-04-19T18:57:00.100Z","kind":"system.boot","actor":"system","prevHash":"0000…0000","hash":"a1b2…c3d4"}
{"v":1,"seq":2,"ts":"2026-04-19T18:57:00.420Z","kind":"gate.inbound.deliver","actor":"system","sessionKey":{"channel":"C01","thread":"17..."},"prevHash":"a1b2…c3d4","hash":"5e6f…7890"}
{"v":1,"seq":3,"ts":"2026-04-19T18:57:01.015Z","kind":"gate.outbound.allow","actor":"claude_process","sessionKey":{"channel":"C01","thread":"17..."},"prevHash":"5e6f…7890","hash":"9abc…def0"}
```

Any edit to any field in line 2 changes its recomputed `hash` —
verification fails at line 2. Reordering lines 2 and 3 makes line 3's
`prevHash` no longer equal line 2's new `hash` — verification fails
at line 3. Deleting line 3 silently (tail truncation) is **not**
detected by the chain alone; see §107-115 for why, and Epic 30-B for
the external-anchor mitigation.

### One-liner

```bash
bun -e 'const { verifyJournal } = await import("./journal.ts"); const r = await verifyJournal(process.argv[1]); if (r.ok) { console.log(`ok: ${r.eventsVerified} events, chain intact`); process.exit(0); } else { const b = r.break; console.error(`tamper at line=${b.lineNumber} seq=${b.seq} ts=${b.ts}\n  reason: ${b.reason}` + (b.expected ? `\n  expected: ${b.expected}\n  actual:   ${b.actual}` : "")); process.exit(1); }' ~/.claude/channels/slack/audit.log
```

Exit codes:

- `0` — chain intact end-to-end.
- `1` — chain break (hash mismatch, `prevHash` mismatch, `seq` gap,
  schema violation, version skew, or parse error).

---

## Storage and rotation

- One file: `<SLACK_AUDIT_LOG or --audit-log-file>` or
  `~/.claude/channels/slack/audit.log`.
- Mode `0o600`.
- Rotation: Epic 30-B, based on file size or external signal. Each
  rotated file is written with a `system.reload` event whose
  `prevHash` ties it to the previous file.
- No retention policy in the plugin — operator decides when to archive.

---

## Relationship to other subsystems

- **Inbound gate** calls `writeEvent({kind: 'gate.inbound.drop', ...})`
  on every rejected event. Drops are journaled even though they never
  reach Claude — this is how we see attack attempts.
- **Outbound gate** journals every reply attempt, allowed or refused.
- **Policy evaluator** has no journal dependency; the caller emits the
  decision event.
- **Session supervisor** emits activate/quiesce/deactivate/quarantine
  events. Quarantine also files a bead (separate subsystem).
- **Pairing flow** emits issued/accepted/expired.

The journal is read-only to every other component except its own
writer. No one else opens the file.

---

## Non-goals

- **Not a log aggregator.** One host, one file.
- **Not a compliance-grade audit system.** The operator is a single
  developer; the threat model treats them as trusted.
- **Not a distributed append log.** No Raft, no external receipts (the
  trusted-anchor publication in 30-B is a one-line gist write, not a
  consensus protocol).
- **Not a metrics pipeline.** Events carry structure sufficient for
  forensics, not for dashboards.
- **Not deletable from the running process.** The writer does not
  expose a `truncate` or `delete` method. Operator removes files via
  the OS when they archive.

---

## Invariants

Every 30-A PR is checked against these.

1. Every security-relevant event flows through exactly one
   `JournalWriter`.
2. Redaction runs before hashing; the hashed form is the on-disk form.
3. `hash_n = sha256(prev_hash || jcs(event_n sans hash))`, SHA-256,
   JCS canonical JSON.
4. `seq` is monotonic per chain and never reset mid-file.
5. Writes are `O_APPEND` + newline-delimited JSON; one line = one
   event.
6. No module outside the writer opens the audit file for write.
7. Verification tool matches the write implementation bit-for-bit;
   both share the serializer.
8. Rotation, when it arrives in 30-B, preserves chain continuity via
   a `system.reload` event whose `prevHash` ties files together.

---

## References

- Schneier, B. & Kelsey, J. (1999). *Secure Audit Logs to Support
  Computer Forensics.* ACM TISSEC — hash-chain construction.
- Sigelman, B. et al. (2010). *Dapper, a Large-Scale Distributed
  Systems Tracing Infrastructure.* Google — correlation ID shape.
- RFC 8785 (2020). *JSON Canonicalization Scheme (JCS)* — serializer
  used for hashing.
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — journal sink component
  definition.
- [`../000-docs/THREAT-MODEL.md`](THREAT-MODEL.md) — T8 (audit-log
  tampering).
- Bead **ccsc-hmj** — this document. Blocks Epic 30-A (ccsc-5pi).
- Epic 30-A children (ccsc-5pi.1 – ccsc-5pi.11) — implementation
  beads.
