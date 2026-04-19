/**
 * policy.ts — Declarative policy engine for claude-code-slack-channel.
 *
 * This module provides the Zod schema for PolicyRule. The evaluate()
 * function, shadow-detection linter, monotonicity check, and path
 * canonicalization land in sibling beads (29-A.3 – 29-A.7). See
 * 000-docs/policy-evaluation-flow.md for the full design contract.
 *
 * Scope of this file for 29-A.1:
 *   - PolicyRule discriminated union (auto_approve | deny | require_approval)
 *   - MatchSpec with at-least-one-field refinement
 *   - Inferred TypeScript types
 *
 * Deliberately narrow surface: no compound combinators, no expression DSL.
 * Three effects only; more is a footgun for shadows.
 *
 * SPDX-License-Identifier: MIT
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// MatchSpec — which tool calls a rule applies to.
// ---------------------------------------------------------------------------

/** Fields a rule's `match` can constrain. Each field is optional; the
 *  refinement below rejects match specs that constrain zero fields (a
 *  rule that matches everything is almost always a bug).
 *
 *  - `tool`       — exact MCP tool name, e.g. "upload_file".
 *  - `pathPrefix` — canonicalized via realpath by evaluate() (29-A.4);
 *                   the value stored here is the pre-resolve literal.
 *  - `channel`    — Slack channel ID, e.g. "C0123456789".
 *  - `actor`      — who is calling the tool. Approvers arrive on a
 *                   later turn so they are not a valid `actor` here.
 *  - `argEquals`  — subset equality on validated MCP input args. Keys
 *                   are compared against the top-level input object;
 *                   every listed key must equal the listed value.
 */
export const MatchSpec = z
  .object({
    tool: z.string().min(1).optional(),
    pathPrefix: z.string().min(1).optional(),
    channel: z.string().regex(/^[CD][A-Z0-9]+$/).optional(),
    actor: z.enum(['session_owner', 'claude_process']).optional(),
    argEquals: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (m) =>
      m.tool !== undefined ||
      m.pathPrefix !== undefined ||
      m.channel !== undefined ||
      m.actor !== undefined ||
      (m.argEquals !== undefined && Object.keys(m.argEquals).length > 0),
    { message: 'match must constrain at least one field' },
  )

export type MatchSpec = z.infer<typeof MatchSpec>

// ---------------------------------------------------------------------------
// PolicyRule — discriminated union over the three effects.
// ---------------------------------------------------------------------------

/** Common fields on every rule — identity and position in the policy set. */
const RuleBase = {
  /** Stable, human-readable identifier. Shows up in audit log + error
   *  messages. Two rules with the same id is a load-time error. */
  id: z.string().min(1).max(120),

  /** Authored order of evaluation; lower first. Equal priorities tie-break
   *  by the rule's position in the array the loader saw. */
  priority: z.number().int().default(100),

  match: MatchSpec,
} as const

/** `auto_approve`: allow the call without operator intervention. */
export const AutoApproveRule = z.object({
  ...RuleBase,
  effect: z.literal('auto_approve'),
})

/** `deny`: refuse the call. `reason` is surfaced to Claude so the model
 *  knows why the tool call was rejected — short, non-sensitive prose. */
export const DenyRule = z.object({
  ...RuleBase,
  effect: z.literal('deny'),
  reason: z.string().min(1).max(200),
})

/** `require_approval`: hold the call until a human approver responds on
 *  Slack. `ttlMs` is how long an approval remains valid after it
 *  arrives; future calls that match the same rule + session within the
 *  window are auto-approved. Default = 5 minutes. */
export const RequireApprovalRule = z.object({
  ...RuleBase,
  effect: z.literal('require_approval'),
  ttlMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000) // 24h hard ceiling
    .default(5 * 60 * 1000),
})

/** Discriminated union over the three effects. evaluate() (29-A.3)
 *  walks a list of these in authored order and returns on the first
 *  rule whose `match` applies. */
export const PolicyRule = z.discriminatedUnion('effect', [
  AutoApproveRule,
  DenyRule,
  RequireApprovalRule,
])

export type PolicyRule = z.infer<typeof PolicyRule>
export type AutoApproveRule = z.infer<typeof AutoApproveRule>
export type DenyRule = z.infer<typeof DenyRule>
export type RequireApprovalRule = z.infer<typeof RequireApprovalRule>

/** Parse an unknown value as a PolicyRule. Throws on invalid input with
 *  Zod's standard error shape. The loader (29-A.5) wraps this with the
 *  shadow-detection linter; direct callers usually want that instead. */
export function parsePolicyRule(raw: unknown): PolicyRule {
  return PolicyRule.parse(raw)
}

/** Parse an unknown value as an array of PolicyRule. Uniqueness of `id`
 *  is NOT enforced here — that check belongs with the loader alongside
 *  shadow detection so both errors are reported together. */
export function parsePolicyRules(raw: unknown): PolicyRule[] {
  return z.array(PolicyRule).parse(raw)
}
