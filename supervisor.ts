/**
 * supervisor.ts — Session supervisor interface for the MCP server.
 *
 * This file is the Epic 32-B entry point. It declares the shape of the
 * SessionSupervisor actor — the single component allowed to create,
 * transition, or destroy sessions — without providing a runtime. The
 * activate / quiesce / deactivate implementations land in sibling beads
 * (ccsc-xa3.2, ccsc-xa3.3, and the deactivate + reaper beads under
 * ccsc-xa3.14). See 000-docs/session-state-machine.md §221-267 for the
 * full behavioural contract this interface pins down, and Armstrong
 * (2003) for the supervisor / lifecycle pattern it borrows from.
 *
 * Design notes:
 *
 *   - **Actor, not a library.** Every mutation of a live session flows
 *     through a single SessionSupervisor owned by server.ts. lib.ts
 *     primitives (sessionPath, saveSession, loadSession) are called only
 *     from here. A session file written by any other path is a bug.
 *
 *   - **One mutex per session file.** Two Slack threads in the same
 *     channel are independent; their handles carry independent mutexes.
 *     The supervisor guarantees serialised `update()` calls per key, not
 *     per channel.
 *
 *   - **Crash is not data loss.** The on-disk file is the source of
 *     truth. In-memory handles are caches. If the process crashes mid-
 *     flight, the next inbound event for that key re-enters Activating
 *     and re-reads the file (see session-state-machine.md §239-247).
 *
 *   - **No policy, no gate, no journal.** The supervisor decides when a
 *     session is loaded, held, flushed, or quarantined — it does not
 *     decide who can speak (inbound gate), which tools run (Epic 29-B),
 *     or what gets logged (Epic 30-A). Those subsystems observe session
 *     state; they never mutate it.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Session, SessionKey } from './lib'

// ---------------------------------------------------------------------------
// Lifecycle state
// ---------------------------------------------------------------------------

/** Observable lifecycle state for one session, mirroring the five-state
 *  FSM in 000-docs/session-state-machine.md §109-155. Nonexistent is
 *  implicit (no handle) so it is not an enumerated value here.
 *
 *  Transitions are strict and are the supervisor's responsibility — the
 *  doc diagram is authoritative, this type is descriptive.
 *
 *    - `activating`   — load-or-create in progress; single-writer critical
 *                       section. Callers of activate() observe this only
 *                       through the returned Promise resolving.
 *    - `active`       — handle is live, `session` reflects the on-disk
 *                       file after the most recent `update()`.
 *    - `quiescing`    — refusing new work; pending writes still flushing.
 *                       `update()` rejects.
 *    - `deactivating` — last flush resolved; handle about to be released.
 *                       Terminal from the caller's perspective.
 *    - `quarantined`  — save or load failure; supervisor filed a beads
 *                       issue and will not auto-reload. Only a human
 *                       (SO) clears this; see session-state-machine.md
 *                       §132-137.
 */
export type SessionState =
  | 'activating'
  | 'active'
  | 'quiescing'
  | 'deactivating'
  | 'quarantined'

// ---------------------------------------------------------------------------
// SessionHandle — in-memory wrapper around one Session file
// ---------------------------------------------------------------------------

/** Live handle to one session. Returned by `SessionSupervisor.activate()`.
 *
 *  Callers treat the handle as opaque: read `session` for the current
 *  snapshot, call `update()` to persist a change. The handle enforces
 *  serialised writes through an internal mutex keyed on this session's
 *  path — two concurrent `update()` calls on the same handle run in
 *  strict order (see session-state-machine.md §210 invariant 1).
 *
 *  A handle is valid only while `state === 'active'`. Once quiesce has
 *  started, `update()` rejects; callers must re-activate to resume.
 */
export interface SessionHandle {
  /** Identity. Immutable for the lifetime of the handle. */
  readonly key: SessionKey

  /** Lifecycle state of this handle as observed by the supervisor.
   *  Consumers may read but must not assume state is stable between
   *  awaits — the reaper or a shutdown signal can transition the
   *  handle out from under them. Always re-check after an `await`. */
  readonly state: SessionState

  /** Most recent successfully persisted snapshot of this session. The
   *  reference may point to frozen / read-only data; callers must not
   *  mutate it in place. Produce the next version inside `update()`. */
  readonly session: Session

  /** Serialise an update through the per-session mutex, persist it via
   *  the atomic writer (`saveSession()`), and refresh `this.session`.
   *
   *  Contract:
   *    - `fn` receives the current session and returns the next one.
   *      It must be pure — no I/O, no sleeps, no throwing except to
   *      signal a validation failure that should abort the update.
   *    - The supervisor persists the returned value with the atomic
   *      writer. Partial state never lands on disk.
   *    - On save failure the handle transitions to `quarantined` and
   *      the returned promise rejects. In-memory `session` reverts to
   *      the pre-update value; no consumer ever sees the failed draft.
   *    - While `state !== 'active'` the promise rejects without
   *      calling `fn`. */
  update(fn: (prev: Session) => Session): Promise<void>
}

// ---------------------------------------------------------------------------
// SessionSupervisor — the actor contract
// ---------------------------------------------------------------------------

/** Supervisor for the per-thread session population. There is exactly one
 *  `SessionSupervisor` per MCP server process; it owns the
 *  `Map<SessionKey, SessionHandle>` named in session-state-machine.md
 *  §229 and is the only code permitted to drive state transitions on
 *  that map.
 *
 *  Armstrong-style shape: the supervisor is a long-lived actor that
 *  delegates work to short-lived per-session children (the handles).
 *  Crashes of a single session are isolated — quarantine a handle, keep
 *  serving every other key. Crashes of the supervisor itself restart
 *  the whole population from disk (see §239-247).
 *
 *  The supervisor is **not** responsible for deciding whether an inbound
 *  event reaches Claude (that is the inbound `gate()` in lib.ts), for
 *  deciding whether a tool call runs (policy evaluator, Epic 29), or
 *  for persisting the audit log (journal sink, Epic 30). It is a pure
 *  session-lifecycle authority.
 */
export interface SessionSupervisor {
  /** Activate the session for `key`: load the file if it exists, create
   *  an empty one if not, and return a live handle.
   *
   *  Contract:
   *    - Idempotent per key. Two concurrent activate() calls for the
   *      same key return the same handle (single-flight, per
   *      session-state-machine.md §266).
   *    - While loading/creating the handle observes `state =
   *      'activating'`; the returned promise resolves only after the
   *      handle reaches `active`.
   *    - Load failure on an existing file transitions to `quarantined`
   *      and rejects the promise; the supervisor files a beads issue
   *      for the SO and never auto-retries.
   *    - Path-validation failure (realpath escape, bad SessionKey
   *      component) rejects before any on-disk work; no session is
   *      recorded for the key.
   *    - Does not enforce idle TTL. Reaper logic lives in the deactivate
   *      path, not here. */
  activate(key: SessionKey): Promise<SessionHandle>

  /** Refuse new work on `key` and wait for pending writes to flush.
   *
   *  Contract:
   *    - After `quiesce()` begins, `update()` on the associated handle
   *      rejects. New `activate()` calls for the same key wait for
   *      quiesce to complete, then re-activate from disk.
   *    - A new inbound event may cancel the quiesce and return the
   *      handle to `active`, per session-state-machine.md §124 (the
   *      `Quiescing → Active` transition). That decision is the
   *      supervisor's; callers of `quiesce()` receive a promise that
   *      resolves in either terminal case.
   *    - Quiesce is idempotent: a second call during an in-flight
   *      quiesce joins the same promise. */
  quiesce(key: SessionKey): Promise<void>

  /** Release the in-memory handle. The on-disk file is left alone.
   *
   *  Contract:
   *    - Must be preceded by a completed `quiesce(key)`. Calling
   *      `deactivate` on an `active` key is a programmer error and
   *      rejects.
   *    - After deactivation, the supervisor's live map no longer
   *      contains `key`. Future inbound events for the same key
   *      re-enter `activate()` and reload the file from disk.
   *    - Quarantined handles are not deactivated through this path —
   *      they persist until a human clears the quarantine flag. */
  deactivate(key: SessionKey): Promise<void>

  /** Graceful shutdown. Quiesces every live session in parallel, awaits
   *  all flushes, then deactivates. Called from server.ts on SIGTERM /
   *  SIGINT and on stdin EOF from the Claude Code host.
   *
   *  After `shutdown()` resolves the supervisor is unusable; a second
   *  `activate()` call rejects. A new supervisor instance is required
   *  to resume, and it will rebuild state from disk. */
  shutdown(): Promise<void>
}
