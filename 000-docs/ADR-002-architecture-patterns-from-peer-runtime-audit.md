# ADR-002: Architecture patterns adopted from a peer-runtime audit

## Status

**Accepted** (2026-06-02).

This ADR records architectural patterns CCSC adopts — and anti-patterns CCSC
self-audits against — after a code-level audit of a peer open-source agent
runtime. The patterns drive a hardening backlog (the `ccsc-*` epics filed
alongside this ADR) and a parallel backlog in the companion governance-plane
product (AGP). This ADR is the rationale anchor those beads cite.

## Provenance (brand-neutral)

The source is an 8-auditor code-level read of a peer open-source agent runtime,
followed by an internal council that ratified a contribution strategy. By
deliberate policy, **no peer brand, product, repository, or maintainer name
appears in this repository.** Provenance is cited only as "the peer-runtime
audit," with the full decision record kept privately at
`contributing-clanker/000-docs/013-AT-DECR` (referred to here as **AT-DECR 013**).

Why brand-neutral: the peer relationship is governed by a separate engagement
track that is gated, sequenced, and disclosure-disciplined. Naming the peer in
committed CCSC files would couple our public hardening work to that private
relationship. The *patterns* are general engineering knowledge; the *peer* is
not ours to name here.

## Context

CCSC is a Slack-native governance substrate: every tool call passes a tiered
policy engine; every decision lands in a hash-chained, Ed25519-signed journal.
The peer runtime occupies an adjacent space — a multi-tenant, sandboxed agent
runtime exposed through Slack — but made the opposite set of bets. It is strong
where CCSC is light (durable execution, network-layer credential isolation,
container sandboxing) and light where CCSC is strong (policy gating, signed
audit, human-in-the-loop). Reading its tree surfaced a set of patterns worth
borrowing and a set of footguns worth turning into regression tests.

This ADR does **not** implement any of it. It names the patterns, fixes the
vocabulary, and points at the backlog that does the work.

## The CCSC ↔ AGP relationship (what propagates downstream)

A load-bearing fact for reading the backlog:

- **CCSC is the substrate.** Its kernel — `policy.ts` `gate()`/`evaluate()`,
  `journal.ts`, the Slack relay, `nonce-hitl.ts` — is the governance core.
- **AGP (agent-governance-plane) vendors a pinned copy of that kernel** per AGP's
  ADR 009 (`000-docs/009-AT-ADR-ccsc-substrate-extraction-strategy.md`,
  Option A: vendor a pinned kernel subset for v0). CCSC has **zero** code
  knowledge of AGP — the dependency is one-way, downstream.
- The two systems' Slack/HITL implementations are **independent
  reimplementations**, not shared code: CCSC's is cross-channel admin verbs
  confirmed by an HMAC nonce from a second channel; AGP's is Block-Kit approval
  of policy `require` verdicts. A shared-kernel convergence ("Option D" in ADR
  009) is the documented end-state, trigger-gated on a second consumer.

**Therefore the routing rule for every pattern below:** substrate-level patterns
land in CCSC and propagate to AGP through the vendored copy; governance-plane-only
patterns land in AGP directly. The `ccsc-*` backlog is the substrate work; the
`agp-*` backlog is the plane-only work.

## Borrowable patterns

Brand-neutral names, with the CCSC seam each maps to.

### 1. Credential placeholder-swap

The agent never holds a real secret. Agent-visible state carries a **placeholder**
string; the real credential is swapped in only at the **outbound boundary**, bound
to a specific destination. The blast radius of a prompt injection no longer
includes the live token.

- **CCSC seam:** today the Claude process reads raw `.env` tokens in-process — the
  injection blast radius includes the live Slack tokens. Epic 2 adopts this:
  placeholders in agent-visible state, real values injected at the Slack tool
  boundary, and `assertSendable()` extended to a value-exfiltration guard.

### 2. Lease-fenced durable execution + crash recovery

Every unit of work holds a **fencing lease** (monotonic token + heartbeat) so
exactly one process owns it; a startup **reconciliation sweep** requeues work
whose lease lapsed and reaps orphans. A turn survives a process restart.

- **CCSC seam:** the supervisor's crash recovery is reload-only with no fencing —
  two processes can both believe they own a turn. Epic 1-A adopts a per-turn lease
  + heartbeat, a restart-recovery sweep, and wires lease-loss into the existing
  quarantine path (Epic 32).

### 3. Transactional-outbox reliable delivery

When work goes terminal, a durable **delivery obligation** is recorded in the same
transaction as the terminal marker; a separate leased **poller** consumes the
obligation, retries transient failures, and dead-letters permanent ones. Delivery
is never a fire-and-forget side effect.

- **CCSC seam:** today a failed `chat.postMessage` is logged to stderr and
  swallowed (per `audit-journal-architecture.md` invariant 1, the projection must
  never block tool execution) — a terminal turn can produce no reply, with no
  retry. Epic 1-B adopts a durable obligation, a retrying/dead-lettering leased
  poller, and idempotent sends.

### 4. Per-thread read isolation

Session state is scoped to its thread; one conversation cannot read another's
state by default.

- **CCSC seam:** CCSC already isolates per-thread session files (Epic 32-A). The
  peer **defaulted cross-thread reads ON** — exactly the footgun CCSC avoids. Epic
  3 converts this into a regression test that proves the isolation holds and fails
  loudly if it regresses. (We are already ahead here; the work is the *proof*.)

### 5. Durable workflow checkpoint / event-wait approval

A durable workflow engine can **suspend** at a checkpoint and **resume** on an
external event — a natural place to hang a human-in-the-loop gate without bespoke
infrastructure.

- **CCSC seam:** CCSC's nonce-HITL already provides cross-channel approval; this
  pattern informs the Epic 5 evaluation of where an approval naturally suspends a
  flow, and informs AGP's checkpoint-style approval direction.

### 6. Declaration-as-enforcement

One declaration drives multiple consumers with no drift: in the peer runtime, a
single per-tool secrets table drives the placeholder, the tool context, **and**
the egress firewall rule. One source of truth, three enforcement points.

- **CCSC seam:** Epic 2's secret-declaration schema is the single source for the
  placeholder, the `assertSendable` guard, and (future) host-bound routing — the
  same one-declaration-three-consumers shape.

## Cautionary anti-patterns (we self-audit against these)

The same audit surfaced footguns. Several are defaults CCSC already gets right;
Epic 3 turns each into a regression test so we *stay* right.

| Anti-pattern (observed in the peer) | CCSC posture | Action |
|---|---|---|
| **Unenforced network policy** — default-deny silently no-ops when the CNI plugin (e.g. flannel) does not enforce NetworkPolicy, so isolation degrades to default-allow with no signal | N/A in CCSC's process model; relevant to AGP's container sandbox | AGP backlog: preflight-check CNI enforcement before trusting isolation |
| **Cross-thread reads default-ON** | CCSC isolates per-thread by default | Epic 3: regression test proving isolation |
| **No durable tool-call record** — only best-effort stdout logs of argument key-names + byte-sizes; no audit table | CCSC journals every decision (allow/deny/require/approved), hash-chained + signed | Epic 3: regression test asserting no decision path skips the journal — **we are already ahead** |
| **Coarse tool authz** — a single `tools:*` scope grants every method of every tool; no allow/deny/require | CCSC's `evaluate()` is per-tool-call allow/deny/require, tier-aware | No new work — **we are already ahead**; noted so the gap stays visible |
| **Mutable, unsigned audit** — plain JSONB rows, no hash-chain, no signature, no verify command | CCSC's journal is hash-chained, Ed25519-signed, with an offline `--verify-audit-log` | No new work — **we are already ahead** |
| **Fail-open defaults** — egress `domains:["*"]`, broad sandbox perms | CCSC gates fail-closed (unknown sender dropped; parse error fatal at boot) | Epic 3: enumerate CCSC defaults, assert fail-closed direction in tests |

The last two rows are the point of the table: on signed audit and per-tool-call
authorization, CCSC is **ahead** of the peer. The hardening backlog is mostly
about durability and the secret boundary, where the peer is ahead of us.

## The security-doc presentation format we adopt

The peer's security documentation is candid in a shape worth copying:

1. **Threat model first** — name the trust boundaries and the adversary before
   the mitigations.
2. **Mitigations with per-item caveats** — each mitigation states its own limit
   inline, not in a footnote ("this stops X; it does not stop Y").
3. **An explicit "what this does NOT protect against" section** — residual risks
   stated plainly, not buried.

Epic 4 restructures `SECURITY.md` and the README security section into this shape,
drawing the residual-risk section from `000-docs/THREAT-MODEL.md`. The honesty of
"here is what we do not defend" is itself a trust signal. (This pass restructures
*presentation*; it does not change any security claim.)

## The Slack-HITL finding (Epic 5 opportunity)

A specific finding worth its own note: the peer runtime **does not wire HITL to
Slack.** Its Slack edge is a thin, stateless webhook listener, and its
human-in-the-loop primitive was designed but never connected to a channel — there
is no approval gate a human can act on from Slack.

Meanwhile, Slack has shipped a native agentic surface — approval previews, Card /
Alert / Data-Table interactive components, and an Agent Browser. CCSC already has
a working cross-channel nonce-HITL and an audit projection. Epic 5 is an
**evaluation** (not a commitment): spike the native approval-preview against our
nonce-HITL, prototype audit receipts with native components, and decide
adopt / hybridize / keep Block Kit — keeping coherence with AGP, since HITL lives
in both systems.

## Decision

Adopt patterns 1–6 as the rationale basis for the `ccsc-*` hardening backlog
(Epics 1–5) and the `agp-*` plane-only backlog, routed by the substrate/plane
rule above. Adopt the three-part security-doc format for `SECURITY.md` and the
README (Epic 4). Treat the anti-pattern table as a standing self-audit checklist.
Name no peer brand in any committed file.

## Consequences

- **Positive:** a concrete, prioritized hardening backlog grounded in a real
  peer's production tradeoffs; the substrate/plane routing keeps CCSC and AGP from
  diverging; the regression tests lock in the defaults where CCSC is already
  ahead; the security docs get more honest.
- **Negative / cost:** Epics 1 and 2 are real durability and secret-boundary work,
  not documentation; the secret placeholder-swap (Epic 2) adds an injection seam
  at the tool boundary that must itself be tested; the brand-neutrality rule means
  future readers cannot follow provenance without access to the private AT-DECR
  013.
- **Non-goals:** this ADR (and the PR that lands it) creates the backlog, the ADR,
  and the README/SECURITY edits only. It does **not** implement the
  durability/secret-firewall features — those are the beads. Nothing here touches
  the peer's repository; the contribution strategy in AT-DECR 013 is a separate,
  gated track.

## Addendum (2026-06-07): the transactional outbox in CCSC's synchronous reply tool (ccsc-o7x.3)

Pattern 3 (transactional-outbox reliable delivery) was specced from a runtime
that **owns the agent loop** and emits a final reply at turn-end. CCSC is
inverted: **Claude is the host that spawns the bridge over MCP stdio, and a
reply is a synchronous `reply` tool call** (`executeReply` → `chat.postMessage`
→ returns the `ts`). There is no bridge-visible "turn terminal." Wiring the
outbox therefore required a contract decision, recorded here because the reply
path is a security boundary (the outbound gate) and CCSC's discipline is
design-before-code for boundary changes.

**Decision — "safety-net behind the reply tool" (Option A).** The `reply` tool
records a durable `DeliveryObligation` *before* the send and the background
poller (`ccsc-o7x.2.2`) is the retry net. Concretely, for the case where the
obligation model maps exactly:

- **Scope: a single-message text reply** — `stream` off, no file uploads, text
  within one chunk, and a thread to post into. This is the overwhelming common
  case and the only shape where one obligation = one Slack message, so the
  idempotency key (`ccsc-o7x.2.3`) dedups *exactly*.
- **Flow:** activate the `(channel, thread)` session → `recordTerminalDelivery`
  (a `pending` obligation, fenced by the lease) → attempt an inline send → on
  **success** mark `delivered` and return the `ts` (happy path **unchanged**);
  on a **transient** Slack error leave it `pending` and return *accepted/queued*
  (so Claude does **not** retry-and-double-post — the poller redelivers
  idempotently); on a **non-retryable** error mark `dead` and throw.
- **Crash-before-send is covered** because the obligation is durable before the
  `chat.postMessage` — the boot-time drain (`ccsc-o7x.3` pt 1) redelivers it.

**Why not the rich paths (yet).** Chunked replies, file uploads, and streaming
(`chat.update`) don't fit a single-payload obligation: chunking is N messages,
files are separate uploads, a stream can't be idempotently replayed. Forcing
them through the outbox would either degrade fidelity on redelivery or risk
partial double-sends. So **they keep today's best-effort behavior and do not
enqueue an obligation** — which means the poller never touches them, so there is
**zero double-send risk** anywhere. Their durability is deferred to follow-up
beads (filed against this addendum), each of which needs its own design step
(e.g. per-chunk keying, an upload-dedup token, a stream-finalize obligation).

**Turn-marker primitives are intentionally not wired.** `recordTurnStart` /
`recordTurnEnd` / `recoverOnStartup` model a turn loop CCSC doesn't have; wiring
them would be speculative no-op code. They remain valid library code (and AGP,
which *does* own a turn loop, can use them via the vendored kernel). The
substrate-vs-plane rule holds: the idempotency *logic* lives in `lib.ts`
(vendored), the Slack I/O glue in `slack-delivery.ts` (CCSC-local).

**Consequence:** the epic's "loss-proof reply" guarantee is delivered for the
common reply shape with exact-once semantics; the rich shapes degrade to
*best-effort, as before* (no regression) with a documented path to full
coverage. This is a deliberate scope cut, not an oversight — recorded so a
future reader knows the rich-path gap is tracked, not missed.

**Build-out status.** The durable-delivery building block —
`deliverReplyDurably` (record → inline send → mark `delivered` / `queued` /
rethrow), with `DurableUnavailableError` for the fall-back-to-direct-send case —
ships in `slack-delivery.ts` and is unit-tested against a real supervisor + a
faked poster. Wiring it into `executeReply`'s single-message branch is the final
step of `ccsc-o7x.3`. The deferred rich-path durability is tracked by
`ccsc-o7x.4` (chunked), `ccsc-o7x.5` (file uploads), and `ccsc-o7x.6`
(streaming).

## Addendum (2026-06-12): chunked (multi-message) replies made durable (ccsc-o7x.4)

The first of the deferred rich paths is now durable. A reply longer than the
chunk limit is split into N Slack messages; the `ccsc-o7x.3` addendum deferred it
because "chunking is N messages [and] forcing it through the outbox would …
risk partial double-sends."

**Decision — one obligation per chunk.** The single-payload `DeliveryObligation`
*does* fit chunking once you model **each chunk as its own obligation** with id
`<reply.id>:<i>`. Each chunk then carries a distinct idempotency key
(`ccsc-reply:<reply.id>:<i>`), so a redelivery dedups *per chunk* — a crash after
posting chunks 0–2 of 5 redelivers only 3–4, never re-posting 0–2.

- **Record all N before any send, atomically.** `recordTerminalDeliveries`
  (the batch sibling of `recordTerminalDelivery`) appends all N `pending`
  obligations AND clears the in-flight marker in **one** fenced write —
  all-or-nothing, so a crash mid-record never leaves a partially-recorded reply
  (some chunks owed, the rest silently dropped).
- **Post in order; stop at the first transient gap.** `deliverChunkedReplyDurably`
  posts chunks in order. On a **transient** error at chunk *i* it marks *i*
  `pending` and **stops** (does not post *i+1…*), returning *queued* — the poller
  redelivers *i…N-1* in order, so a chunk never lands ahead of an earlier one.
  On a **non-retryable** error it marks *i* `dead` and rethrows (chunks 0…*i*-1
  already landed — the honest partial-reply outcome).
- **The poller is untouched.** Because each chunk is just a normal
  `DeliveryObligation` with a unique key, `pendingDeliveries` (array order) +
  `drainOutbox` (sequential) already preserve order and dedup per chunk — zero
  poller changes. `lib.ts` (the AGP-vendored kernel) is likewise unchanged.

**Ordering guarantee (inline and via the poller).** Obligations append in chunk
order; the inline path posts in order and stops at the first transient gap; the
poller drains a session's outbox in array order. So a chunk never lands ahead of
an earlier one on either path.

**Scope still deferred:** file uploads (`ccsc-o7x.5`) and streaming
(`ccsc-o7x.6`). Files are separate uploads (need an upload-dedup token); a stream
can't be idempotently replayed (needs a stream-finalize obligation). Until then
those two keep best-effort behavior and do not enqueue — zero double-send risk,
same as before.

## Addendum (2026-06-24): streaming replies made durable (ccsc-o7x.6)

The second deferred rich path. A streaming reply (`stream:true`, text over the
chunk limit) posts an initial message and grows it via `chat.update`
(`stream-reply.ts`). The `ccsc-o7x.3` addendum deferred it because "a stream
can't be idempotently replayed" — you cannot re-run a progressive `chat.update`
sequence after a crash and land in the same place.

**Decision — a stream-finalize obligation carrying the full text.** Before the
stream starts, record ONE `pending` `DeliveryObligation` whose `payload` is the
**complete** reply text (not a chunk). The obligation is a *crash safety-net for
the whole stream*, not a per-chunk record:

- **`completed`** → mark the obligation `delivered`. The streamed message already
  holds the full content; nothing is owed.
- **clean mid-stream failure** (`failed_mid_stream`, or a thrown init error) →
  mark the obligation **`dead`**, NOT pending. This is the load-bearing safety
  rule: the delivery poller's `send` does **not** re-run `assertOutboundAllowed`
  (it is a pure redelivery path), and `streamReply`'s single mid-stream catch
  cannot distinguish a gate rejection (channel removed mid-stream) from a
  transient Slack error. Leaving the obligation `pending` would let the poller
  redeliver the full text to a channel the outbound gate just rejected — a gate
  bypass. So an *in-process* stream failure resolves terminal (`dead`, with the
  reason recorded) and is never auto-redelivered; the partial message that landed
  is the same best-effort outcome as before.
- **process crash mid-stream** (no result at all — the process dies) → the
  obligation stays `pending`, and the boot-time drain / poller redelivers the
  **full text as a fresh `chat.postMessage`**. The partial streamed message is
  orphaned; the user gets the complete message after restart. This is exactly the
  bead's wording: "a crash mid-stream redelivers the final message."

**Why no kernel or poller change.** The full-text obligation is an ordinary
single-message `DeliveryObligation` (`payload` = full text). The existing poller
posts `payload` via `chat.postMessage` — precisely the redelivery we want — and
the idempotency key (`ccsc-o7x.2.3`) dedups *poller-side* re-attempts of that
obligation. `lib.ts` (the AGP-vendored kernel) and `drainOutbox` are untouched.

**Residual (documented, narrow).** The streamed message itself is posted by
`stream-reply.ts` without our delivery `metadata` stamp, so `findDelivered`
cannot recognise it. Therefore the one un-deduped duplicate is the
**completed-but-crashed-before-marking-`delivered`** window: the full stream
landed, the process died in the microtask before the `delivered` mark, so the
poller redelivers a second full copy. The mark is written immediately on
`completed` to keep the window minimal. This mirrors the pre-idempotency-key
residual of the text path (`ccsc-o7x.2.3`) and is the accepted cost of "a stream
can't be idempotently replayed."

A second, narrower edge: the redelivery posts the full text as ONE
`chat.postMessage`. A reply whose full text exceeds Slack's 40k single-message
limit would redeliver as `msg_too_long` and **dead-letter** (recorded, not
silent) — but such a reply could not have streamed cleanly in the first place
(`chat.update` shares the same 40k limit, so it would have hit
`failed_mid_stream` → `dead` before completing). The only way to reach it is a
process crash before the stream organically hit that wall. Chunking the
finalize obligation (as `ccsc-o7x.4` does for chunked replies) would close it;
deferred as not worth the complexity for that window.

**Scope still deferred:** file uploads (`ccsc-o7x.5`) — separate uploads that
need an additive `files` field on the obligation, a poller send-adapter that
branches to `filesUploadV2`, and an upload-dedup token (a `filesUploadV2`
message-share does not carry our `chat.postMessage` metadata). Its own addendum
and PR.

## References

- The `ccsc-*` peer-audit hardening backlog (Epics 1–5), filed alongside this ADR;
  each bead cites this ADR.
- AGP ADR 009 — `agent-governance-plane/000-docs/009-AT-ADR-ccsc-substrate-extraction-strategy.md`
  (CCSC-is-substrate / AGP-vendors-it contract).
- `000-docs/THREAT-MODEL.md` — trust boundaries, T1–T11, residual risks (source for
  the Epic 4 "does NOT protect against" section).
- `000-docs/audit-journal-architecture.md` — the projection-must-not-block invariant
  that motivates Epic 1-B.
- `000-docs/session-state-machine.md` — supervisor contract that Epic 1-A extends.
- AT-DECR 013 (private) — the engagement decision record and full provenance.
- ADR-001 — capability-token format evaluation (the existing ADR; this is the next
  in sequence).
