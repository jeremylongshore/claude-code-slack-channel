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
 *  here, forcing a schema bump. */
const SessionKeyShape = z.object({
  channel: z.string(),
  thread: z.string(),
}) satisfies z.ZodType<SessionKey>

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
