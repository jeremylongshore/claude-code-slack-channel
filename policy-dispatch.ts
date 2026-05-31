/**
 * policy-dispatch.ts — Side-effect-free dispatcher helpers for policy
 * decisions (ccsc-06s).
 *
 * Lives in its own module so the test suite can import the production
 * code path directly. server.ts has boot-time side effects
 * (process.exit on missing .env) that prevent direct import in the
 * test runner — but these helpers are pure, so a sibling module is
 * the right shape. Mirrors the acp-adapter.ts pattern locked in by
 * PR #173 (Gemini-flagged drift risk on inlined duplicates).
 *
 * Scope of this module:
 *   - buildDenyNotificationParams() — wire-format invariant for the
 *     MCP notification sent to Claude on policy.deny
 *   - recordPolicyDenyToJournal() — two-event journal sequence:
 *     full-detail policy.deny + sanitised policy.deny.context_stripped
 *
 * What this module does NOT do:
 *   - Send the actual MCP notification. server.ts owns the MCP
 *     transport; this module produces the body.
 *   - Choose whether to deny. policy.ts owns evaluate(); this module
 *     handles the side of dispatch that comes AFTER the deny verdict.
 *   - Mutate Claude's conversation history directly. CCSC's MCP-bridge
 *     architecture cannot — Claude Code owns that surface. The
 *     minimisation lives on the notification side: Claude observes a
 *     deny WITH NO retry-aiding metadata. See 000-docs/policy-
 *     evaluation-flow.md § Context-stripping (ccsc-06s) for the
 *     architectural rationale.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JournalWriter } from './journal.ts'

// ---------------------------------------------------------------------------
// Wire-format invariant — buildDenyNotificationParams (ccsc-06s)
// ---------------------------------------------------------------------------

/** Shape of the MCP notification body the server sends to Claude on
 *  a policy.deny decision. The literal type on `behavior` pins the
 *  wire-format invariant statically — TypeScript refuses any shape
 *  with extra keys at the call site.
 *
 *  Why `type` (not `interface`): per Gemini review on PR #178, type
 *  aliases with concrete properties are implicitly assignable to
 *  `Record<string, unknown>` because type aliases are closed (no
 *  declaration merging). Interfaces would require an explicit
 *  `[k: string]: unknown` index signature — which would silently
 *  relax the ccsc-06s minimisation by permitting extra keys at the
 *  call site. The `type` form keeps the wire shape EXACTLY two
 *  fields while still satisfying the MCP SDK's
 *  `Record<string, unknown>` parameter type. */
export type DenyNotificationParams = {
  request_id: string
  behavior: 'deny'
}

/** Build the deny-notification body. The ONLY two fields produced at
 *  runtime are `request_id` (so the receiver correlates) and
 *  `behavior: 'deny'`. Rule id, denial reason, and input echo are
 *  intentionally omitted — any of those would seed a retry-rephrase
 *  loop in Claude's next turn.
 *
 *  The helper exists so the wire-format invariant has one obvious
 *  surface to test against. See server.test.ts §"ccsc-06s
 *  buildDenyNotificationParams". */
export function buildDenyNotificationParams(request_id: string): DenyNotificationParams {
  return { request_id, behavior: 'deny' }
}

// ---------------------------------------------------------------------------
// Two-event journal sequence — recordPolicyDenyToJournal (ccsc-06s)
// ---------------------------------------------------------------------------

/** Full detail recorded on the FIRST of the two deny events. The
 *  audit log keeps everything — the minimisation lives on the
 *  notification side, not the journal side. `sessionKey` is optional
 *  to match the dispatcher: a denial can occur on a tool call that
 *  hasn't yet been bound to a session (early-flow rejections), and
 *  the journal schema permits an absent sessionKey on those events. */
export interface PolicyDenyDetail {
  sessionKey?: { channel: string; thread: string }
  toolName: string
  input: Record<string, unknown>
  ruleId: string
  reason: string
}

/** Write the two-event sequence the ccsc-06s dispatcher requires:
 *
 *    1. `policy.deny` with FULL detail (forensic record)
 *    2. `policy.deny.context_stripped` with NO retry-aiding fields
 *
 *  Both are awaited so that on return, the JournalWriter's serial
 *  queue has drained at least these two events past the recovery
 *  point. The caller can then send the minimal MCP notification
 *  knowing the journal record is durable.
 *
 *  Order is enforced by `await` — there is no path through which the
 *  second event is written before the first. Tested directly in
 *  server.test.ts §"ccsc-06s recordPolicyDenyToJournal".
 *
 *  Defensive on each write: a broken audit log MUST NOT interrupt
 *  the denial — the policy decision is authoritative even if the
 *  journal is wedged. Errors are surfaced to stderr but never thrown,
 *  AND the second write is attempted whether or not the first
 *  succeeded (audit-resilience invariant). */
export async function recordPolicyDenyToJournal(
  writeEvent: (input: Parameters<JournalWriter['writeEvent']>[0]) => Promise<unknown>,
  detail: PolicyDenyDetail,
): Promise<void> {
  try {
    await writeEvent({
      kind: 'policy.deny',
      outcome: 'deny',
      actor: 'claude_process',
      sessionKey: detail.sessionKey,
      toolName: detail.toolName,
      input: detail.input,
      ruleId: detail.ruleId,
      reason: detail.reason,
    })
  } catch (err) {
    console.error('[slack] journal.writeEvent failed (policy.deny)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    await writeEvent({
      kind: 'policy.deny.context_stripped',
      outcome: 'n/a',
      actor: 'system',
      sessionKey: detail.sessionKey,
      toolName: detail.toolName,
      // Intentionally NO input / ruleId / reason here. The preceding
      // policy.deny event carries those. Recording them again would
      // defeat the audit-purpose distinction between the two events.
    })
  } catch (err) {
    console.error('[slack] journal.writeEvent failed (policy.deny.context_stripped)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
