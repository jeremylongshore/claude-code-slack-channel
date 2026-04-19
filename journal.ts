/**
 * journal.ts — Tamper-evident audit journal for the Slack↔Claude-Code bridge.
 *
 * This file is the Epic 30-A entry point. Scope of this bead (ccsc-5pi.1)
 * is narrow: the `JournalEvent` schema and its inferred type. The writer,
 * redaction module, canonical-JSON serializer, and verification command
 * land in sibling beads (ccsc-5pi.2 – ccsc-5pi.16). See
 * 000-docs/audit-journal-architecture.md for the full contract.
 *
 * Shape of a journal event (audit-journal-architecture.md §19-59):
 *
 *   {
 *     v:        1,                          // schema version; chain refuses mixed versions
 *     ts:       '2026-04-19T12:34:56.789Z', // ISO-8601 UTC with ms precision
 *     seq:      42,                         // monotonic per chain
 *     kind:     'gate.inbound.drop',        // discriminated union of 19 event kinds
 *     toolName?: 'reply',
 *     input?:   { chat_id: 'C01', text: '...' },     // post-redaction
 *     outcome?: 'allow' | 'deny' | 'require' | 'drop' | 'n/a',
 *     reason?:  'peer bot not in allowFrom',
 *     ruleId?:  'no-exfil-to-untrusted-channel',
 *     sessionKey?: { channel: 'C01', thread: '1711000000.000100' },
 *     actor?:   'session_owner' | 'claude_process' | ...,
 *     correlationId?: 'req-abc123',
 *     prevHash: 'e3b0c44...',                // sha256 hex, 64 chars
 *     hash:     'b94d27b...',                // sha256 hex, 64 chars
 *   }
 *
 * Why `strict()` on the schema: the chain property depends on every writer
 * and every verifier hashing the **same bytes**. Accepting unknown fields
 * would let callers sneak unredacted content through the writer's redactor
 * (which only walks the documented fields). Strict mode surfaces those
 * mistakes at build time or on the first `parse()` call.
 *
 * SPDX-License-Identifier: MIT
 */

import { z } from 'zod'
import { createHash, randomBytes } from 'crypto'
import { open as fsOpen, type FileHandle } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import type { SessionKey } from './lib'

// ---------------------------------------------------------------------------
// Event kinds — discriminated union tag
// ---------------------------------------------------------------------------

/** Every security-relevant event the journal records. Pinned by
 *  000-docs/audit-journal-architecture.md §40-59; adding a new kind is an
 *  intentional schema change and should be justified in a design-doc PR
 *  before the code PR.
 *
 *  Grouping (for the reader, not enforced):
 *    - `gate.*`        inbound/outbound gate decisions (lib.ts)
 *    - `policy.*`      evaluator decisions + approval flow (policy.ts)
 *    - `exfil.block`   `assertSendable()` refusal
 *    - `session.*`     supervisor lifecycle transitions (supervisor.ts)
 *    - `pairing.*`     DM-pairing state machine (access.json)
 *    - `system.*`      boot, shutdown, rotation
 */
export const EventKind = z.enum([
  'gate.inbound.deliver',
  'gate.inbound.drop',
  'gate.outbound.allow',
  'gate.outbound.deny',
  'policy.allow',
  'policy.deny',
  'policy.require',
  'policy.approved',
  'exfil.block',
  'session.activate',
  'session.quiesce',
  'session.deactivate',
  'session.quarantine',
  'pairing.issued',
  'pairing.accepted',
  'pairing.expired',
  'system.boot',
  'system.shutdown',
  'system.reload',
])

/** TypeScript string union of the 19 event kinds. */
export type EventKind = z.infer<typeof EventKind>

// ---------------------------------------------------------------------------
// Supporting enums
// ---------------------------------------------------------------------------

/** Outcome of a gated action. `n/a` is the legitimate value for events
 *  that are observational rather than decision-emitting (e.g.
 *  `system.boot`, `session.activate`). Keep this set tight so the
 *  verification tool can normalize cleanly. */
export const Outcome = z.enum(['allow', 'deny', 'require', 'drop', 'n/a'])
export type Outcome = z.infer<typeof Outcome>

/** Who initiated or owns the action being recorded. Mirrors the
 *  four-principal model in ARCHITECTURE.md; `system` is the catch-all
 *  for supervisor / reaper / boot-path entries that have no human or
 *  agent actor. */
export const Actor = z.enum([
  'session_owner',
  'claude_process',
  'human_approver',
  'peer_agent',
  'system',
])
export type Actor = z.infer<typeof Actor>

// ---------------------------------------------------------------------------
// Primitive shapes
// ---------------------------------------------------------------------------

/** SHA-256 hex string: exactly 64 lowercase hex chars. Enforced at
 *  parse time so a malformed `prevHash` / `hash` is caught before it
 *  reaches the verifier. The writer produces them via `toString('hex')`
 *  on a Node crypto digest, which is guaranteed lowercase. */
const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, {
    message: 'sha256 hex must be 64 lowercase hex chars',
  })

/** Subset match of `SessionKey` from lib.ts. Duplicated here rather
 *  than reusing the lib schema because the journal must be hashable
 *  independent of whether lib.ts is loaded; keeping the structure
 *  literal keeps the JCS canonical form frozen to this file.
 *
 *  The `satisfies` assertion guarantees the shape stays in lock-step
 *  with the `SessionKey` type — a lib-side rename breaks the build
 *  here, forcing a schema bump.
 *
 *  `.strict()` for the same reason the top-level `JournalEvent` is
 *  strict: two writers that disagree on what fields live inside
 *  `sessionKey` would hash to different canonical forms and break the
 *  chain. Reject unknown fields at parse time. */
const SessionKeyShape = z
  .object({
    channel: z.string(),
    thread: z.string(),
  })
  .strict() satisfies z.ZodType<SessionKey>

// ---------------------------------------------------------------------------
// JournalEvent — the on-disk record shape
// ---------------------------------------------------------------------------

/** One line in `audit.log` after canonical serialization. Every field
 *  is either required (carried by every event) or optional with a clear
 *  meaning when absent.
 *
 *  Why `strict()`: unknown fields on a journal event mean either (a) a
 *  caller is trying to sneak unredacted data through the writer, or
 *  (b) two components disagree on the schema. Both need to be loud,
 *  not swallowed. The cost is that schema growth requires a coordinated
 *  bump of `v` — which is exactly the right friction for a forensic
 *  record.
 *
 *  Canonicalisation note: when the writer (ccsc-5pi.2) hashes an event
 *  it strips `hash` and JCS-serializes the rest. The schema therefore
 *  accepts `hash` as required — partial events without `hash` are a
 *  writer-internal intermediate, not a valid on-disk record.
 */
export const JournalEvent = z
  .object({
    /** Schema version. Bumped on any shape change; verify-journal (ccsc-
     *  5pi.9) refuses a chain that mixes versions so a v1 → v2 rollover
     *  cannot silently desync. */
    v: z.literal(1),

    /** ISO-8601 UTC timestamp with millisecond precision, e.g.
     *  `2026-04-19T12:34:56.789Z`. The writer sets this from `nowIso()`
     *  at append time; callers must not pre-populate. `z.string().datetime()`
     *  enforces the ISO form and mandates a trailing `Z` / offset. */
    ts: z.string().datetime({ offset: true, precision: 3 }),

    /** Monotonic sequence number. Starts at 1 on the first event after
     *  boot and never resets within a chain. A gap between consecutive
     *  events is a tamper signal during verification — see audit-
     *  journal-architecture.md §61-73. */
    seq: z.number().int().nonnegative(),

    /** Discriminated tag identifying what happened. See `EventKind`
     *  above for the enumerated set. */
    kind: EventKind,

    /** MCP tool name when the event involves a tool call. Absent for
     *  session / pairing / system events. */
    toolName: z.string().min(1).optional(),

    /** Redacted tool-call arguments. Every secret-shaped value has been
     *  replaced with `[REDACTED:<kind>]` before this field is hashed or
     *  written. Nested structures are walked recursively by the redactor
     *  (ccsc-5pi.4). */
    input: z.record(z.string(), z.unknown()).optional(),

    /** Outcome classifier for decision events. `n/a` is valid and
     *  required for observational events; absence is valid too (same
     *  semantic). */
    outcome: Outcome.optional(),

    /** Short, human-readable explanation. Redacted before hashing.
     *  Carries no PII or secret material by contract — if you find a
     *  counter-example, file a bead against the caller, not the schema. */
    reason: z.string().optional(),

    /** Identifier of the matched policy rule for `policy.*` events. */
    ruleId: z.string().min(1).optional(),

    /** Owning session when the event is session-scoped. Absent for
     *  `system.*` and some `pairing.*` events that predate session
     *  creation. */
    sessionKey: SessionKeyShape.optional(),

    /** Who triggered or owns the event. See `Actor` above. */
    actor: Actor.optional(),

    /** Dapper-style correlation id linking related events — a single
     *  tool call's policy-require → pairing-issued → pairing-accepted →
     *  policy-approved → gate-outbound-allow all share one
     *  `correlationId`. Absent for events that have no cross-cutting
     *  trace (boot, reload). */
    correlationId: z.string().min(1).optional(),

    /** SHA-256 hex of the preceding event. The very first event in a
     *  chain uses `sha256(TRUSTED_ANCHOR)`; see audit-journal-
     *  architecture.md §76-85 for the anchor contract. */
    prevHash: Sha256Hex,

    /** SHA-256 hex of `prevHash || canonicalJson(event sans hash)`.
     *  Computed by the writer (ccsc-5pi.2) and verified bit-for-bit by
     *  the verify-journal command (ccsc-5pi.9). */
    hash: Sha256Hex,
  })
  .strict()

/** Inferred TypeScript shape of `JournalEvent`. Prefer this over the
 *  Zod type when writing application code — the Zod object is the
 *  parser, the TS type is the data. */
export type JournalEvent = z.infer<typeof JournalEvent>

/** Narrower type for the writer's pre-hash intermediate form: all the
 *  fields that go into the hash, without `hash` itself. The writer
 *  computes `sha256(prevHash || jcs(PartialEvent))` and then attaches
 *  `hash` to produce a full `JournalEvent`. Not exported as a Zod
 *  schema — it is a writer-internal shape, not a valid on-disk record. */
export type PartialJournalEvent = Omit<JournalEvent, 'hash'>

// ---------------------------------------------------------------------------
// JournalWriter — SHA-256 hash-chained append-only writer (ccsc-5pi.2)
// ---------------------------------------------------------------------------

/** Everything a caller supplies for a new event. The writer fills in the
 *  framing fields (`v`, `ts`, `seq`, `prevHash`, `hash`) so callers cannot
 *  drift the hash-determining fields by accident.
 *
 *  Note the Omit excludes `v` even though it is a literal — the writer
 *  always sets it to 1. When the schema version bumps, callers do not
 *  need to update. */
export type WriteInput = Omit<JournalEvent, 'v' | 'ts' | 'seq' | 'prevHash' | 'hash'>

/** Construction options for `JournalWriter.open()`.
 *
 *  Defaults give you a production-shaped writer. Tests override `now` and
 *  `initialPrevHash` to keep hash assertions deterministic.
 */
export interface WriterOptions {
  /** Absolute path to the audit log file. Created with mode `0o600` if
   *  it doesn't exist. */
  path: string

  /** Genesis `prevHash` for an empty file. Default is a fresh random
   *  32-byte sha256, matching the "TRUSTED_ANCHOR" concept in
   *  audit-journal-architecture.md §76-85. Callers that want the anchor
   *  recorded in the first event's body pre-compute it and pass it here.
   *  Ignored when the file is non-empty — existing chains dictate their
   *  own lastHash. */
  initialPrevHash?: string

  /** Clock source for `ts`. Injected in tests so assertions can fix the
   *  timestamp. Default: real wall clock. */
  now?: () => Date
}

/** Module-level registry of open audit-log paths. Enforces the
 *  "single JournalWriter per process" invariant (audit-journal-
 *  architecture.md §148-151, invariant §312-326 #1). A second `open()`
 *  on the same path while the first writer is still live rejects rather
 *  than allowing two writers to interleave their hash chains silently. */
const ACTIVE_PATHS = new Set<string>()

/** Tamper-evident append-only writer. See audit-journal-architecture.md
 *  §76-161 for the full contract. One writer per process per path.
 *
 *  Lifecycle:
 *    1. `JournalWriter.open({ path })` — opens the file in append mode,
 *       reads any existing content to recover `lastHash` + `seq`, and
 *       registers the path.
 *    2. `.writeEvent(input)` — serializes through an internal queue so
 *       concurrent callers cannot interleave increments. Computes
 *       `hash = sha256(lastHash || jcs(event sans hash))`, appends a
 *       newline-delimited JSON line, and returns the full event.
 *    3. `.close()` — flushes, closes the file descriptor, frees the
 *       path registration.
 *
 *  Fail-loud posture: any write failure puts the writer into a broken
 *  state and subsequent `writeEvent` calls reject. Recovery is an
 *  operator concern — inspect and restart. Silent recovery would
 *  violate the forensic-record invariant.
 */
export class JournalWriter {
  private fh: FileHandle | null
  private lastHash: string
  private nextSeq: number
  private readonly now: () => Date
  private readonly path: string

  /** Serialization queue. Every `writeEvent` chains onto this promise so
   *  that increment → hash → append runs as a single critical section
   *  per call, regardless of how many callers await concurrently. */
  private queue: Promise<unknown> = Promise.resolve()

  /** Non-null when the writer has encountered a fatal write error. All
   *  subsequent `writeEvent` calls reject with this error. */
  private broken: Error | null = null

  private constructor(
    fh: FileHandle,
    lastHash: string,
    nextSeq: number,
    now: () => Date,
    path: string,
  ) {
    this.fh = fh
    this.lastHash = lastHash
    this.nextSeq = nextSeq
    this.now = now
    this.path = path
  }

  /** Open (or create) an audit log at `opts.path` and return a ready-
   *  to-write JournalWriter.
   *
   *  Recovers chain state from the existing file: reads the last
   *  newline-delimited JSON line, parses it through the `JournalEvent`
   *  schema, and uses its `hash` and `seq + 1` as the seeds for new
   *  writes. If the file is empty or absent, seeds from
   *  `opts.initialPrevHash` (or a fresh random sha256 if unset) and
   *  seq 1.
   *
   *  Throws if:
   *    - Another `JournalWriter` is already open on the same path in
   *      this process (single-writer invariant).
   *    - The existing file's last line is not valid `JournalEvent`
   *      JSON — fail loudly rather than silently start a new chain
   *      that the verifier would reject anyway.
   */
  static async open(opts: WriterOptions): Promise<JournalWriter> {
    if (ACTIVE_PATHS.has(opts.path)) {
      throw new Error(
        `JournalWriter.open: path already has an active writer in this process: ${opts.path}`,
      )
    }

    let lastHash: string
    let nextSeq: number

    if (existsSync(opts.path)) {
      const content = readFileSync(opts.path, 'utf8')
      const lines = content.split('\n').filter((line) => line.length > 0)
      if (lines.length === 0) {
        // File exists but is empty — treat as fresh chain. Not an error;
        // happens when an operator pre-created the file with `touch`.
        lastHash = opts.initialPrevHash ?? sha256Hex(randomBytes(32))
        nextSeq = 1
      } else {
        const lastLine = lines[lines.length - 1]!
        let parsed: JournalEvent
        try {
          parsed = JournalEvent.parse(JSON.parse(lastLine))
        } catch (err) {
          throw new Error(
            `JournalWriter.open: last line of ${opts.path} is not a valid JournalEvent — refusing to start a new chain that would be unverifiable. Underlying error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
        lastHash = parsed.hash
        nextSeq = parsed.seq + 1
      }
    } else {
      lastHash = opts.initialPrevHash ?? sha256Hex(randomBytes(32))
      nextSeq = 1
    }

    // Mode 0o600 on creation; 'a' flag sets O_APPEND|O_WRONLY|O_CREAT.
    // POSIX guarantees O_APPEND writes land atomically at EOF even with
    // concurrent writers — we still serialize via the queue for the
    // hash chain, not for write safety.
    const fh = await fsOpen(opts.path, 'a', 0o600)
    ACTIVE_PATHS.add(opts.path)

    return new JournalWriter(
      fh,
      lastHash,
      nextSeq,
      opts.now ?? ((): Date => new Date()),
      opts.path,
    )
  }

  /** Append a new event. Returns the fully-framed `JournalEvent` that
   *  was persisted, including the writer-assigned `v`, `ts`, `seq`,
   *  `prevHash`, and `hash`.
   *
   *  Concurrent calls are serialized: if caller A and caller B both
   *  `writeEvent()` without awaiting, the promises resolve in call
   *  order and each sees a contiguous seq/hash chain.
   */
  async writeEvent(input: WriteInput): Promise<JournalEvent> {
    if (this.broken) {
      return Promise.reject(
        new Error(
          `JournalWriter is broken after a prior write failure: ${this.broken.message}`,
        ),
      )
    }
    if (this.fh === null) {
      return Promise.reject(new Error('JournalWriter.writeEvent: writer is closed'))
    }
    // Chain onto the existing queue so increments are serialized. Using
    // .then (not await) captures the write call's position in line
    // immediately; callers observe monotonic order regardless of
    // microtask scheduling.
    const p = this.queue.then(() => this._doWrite(input))
    // Swallow rejections on the queue itself so one failed write does
    // not poison the queue chain. The caller still sees the rejection
    // from `p`. The writer's `broken` field guards future calls.
    this.queue = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }

  private async _doWrite(input: WriteInput): Promise<JournalEvent> {
    if (this.fh === null) {
      throw new Error('JournalWriter._doWrite: writer closed mid-queue')
    }
    const partial: PartialJournalEvent = {
      v: 1,
      ts: this.now().toISOString(),
      seq: this.nextSeq,
      prevHash: this.lastHash,
      ...input,
    }
    const hash = sha256Hex(this.lastHash + canonicalJson(partial))
    const event: JournalEvent = { ...partial, hash }

    // Validate through the schema at the boundary. Catches caller-
    // supplied fields that violate the strict schema (unknown keys,
    // malformed types) before they land on disk and desync the chain.
    JournalEvent.parse(event)

    const line = JSON.stringify(event) + '\n'
    try {
      await this.fh.write(line)
    } catch (err) {
      this.broken = err instanceof Error ? err : new Error(String(err))
      throw this.broken
    }

    // Advance chain state only after the write succeeds. A crash mid-
    // write leaves `lastHash` and `nextSeq` at the pre-write values,
    // so a restart-then-write resumes at the same point rather than
    // gapping the seq or duplicating the hash.
    this.nextSeq += 1
    this.lastHash = hash

    return event
  }

  /** The current chain-head hash. Exposed so callers that need the
   *  "latest known good" pointer (e.g. the tail-anchor publisher in
   *  Epic 30-B) can read it without parsing the last line of disk. */
  get headHash(): string {
    return this.lastHash
  }

  /** The seq the next successful write will carry. Useful for tests
   *  and for operator diagnostics. */
  get nextSequenceNumber(): number {
    return this.nextSeq
  }

  /** Flush and release the file descriptor. Idempotent: calling
   *  `close()` on an already-closed writer is a no-op. After close,
   *  `writeEvent()` rejects. */
  async close(): Promise<void> {
    if (this.fh === null) return
    try {
      await this.fh.close()
    } finally {
      this.fh = null
      ACTIVE_PATHS.delete(this.path)
    }
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON (RFC 8785 subset for integer-only event shapes)
// ---------------------------------------------------------------------------

/** Canonicalise `value` for hashing. Two independent encoders must
 *  produce identical byte output so the verifier can recompute the
 *  chain bit-for-bit.
 *
 *  RFC 8785 compliance notes:
 *    - Strings: `JSON.stringify` matches the RFC 8785 escape rules for
 *      all inputs that avoid non-BMP Unicode. Our event schema never
 *      has strings chosen from outside the BMP (hashes are hex; ts is
 *      ISO-8601; Slack IDs are ASCII; policy reason strings are
 *      operator-authored ASCII).
 *    - Numbers: the RFC mandates shortest IEEE-754 double form. Our
 *      schema permits only integers (`seq`); other number forms throw.
 *    - Objects: keys sorted by UTF-16 code-unit order (the RFC form),
 *      which `Array.prototype.sort` delivers for the ASCII key names
 *      the schema uses.
 *    - Arrays: order-preserving.
 *    - No whitespace.
 *
 *  Throws on `undefined`, functions, symbols, bigints — none are valid
 *  `JournalEvent` content; the throw turns a schema-validation miss
 *  into a loud failure at hash time.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(
        `canonicalJson: only finite integer numbers supported (got ${String(value)})`,
      )
    }
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const pairs = keys.map(
      (k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]),
    )
    return '{' + pairs.join(',') + '}'
  }
  throw new Error(`canonicalJson: unsupported value type: ${typeof value}`)
}

// ---------------------------------------------------------------------------
// sha256 helper
// ---------------------------------------------------------------------------

/** Compute SHA-256 over `input` and return 64-char lowercase hex. Used
 *  by the writer for the hash chain and re-used by the verifier
 *  (ccsc-5pi.9). Kept close to the type + writer so all hash producers
 *  in this module share one implementation. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}
