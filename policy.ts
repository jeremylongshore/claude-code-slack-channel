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
import { realpathSync } from 'fs'
import { resolve, sep } from 'path'

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

  /** Tie-breaker within effect when two rules would otherwise be
   *  equivalent. Primary ordering is authored array position (first-
   *  applicable, see 000-docs/policy-evaluation-flow.md §Combining).
   *  Lower `priority` wins the tie. */
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

// ---------------------------------------------------------------------------
// PolicyDecision — output of evaluate(). See 000-docs/policy-evaluation-flow.md §27-30.
// ---------------------------------------------------------------------------

/** The decision returned by `evaluate()`. Three kinds — a deliberately
 *  narrow surface. `allow` is the happy path; `deny` refuses with a
 *  reason surfaced to Claude; `require` pauses until a human approver
 *  responds on Slack within `ttlMs`.
 *
 *  Not confused with `PolicyRule.effect` (the *input* shape): rule
 *  effects are `auto_approve | deny | require_approval`; decisions are
 *  `allow | deny | require`. An `auto_approve` rule produces an `allow`
 *  decision; a `require_approval` rule produces a `require` decision
 *  unless a fresh approval is already in flight (which turns it into
 *  `allow`). See the flowchart in policy-evaluation-flow.md.
 *
 *  **No runtime validation.** Decisions are produced by `evaluate()`
 *  from validated inputs, never parsed from untrusted data, so a Zod
 *  schema here would be dead weight. The type alone is the contract.
 */
export type PolicyDecision =
  | {
      kind: 'allow'
      /** ID of the matching rule. Absent when the default branch fires
       *  (no rule matched + tool not in `requireAuthoredPolicy`). */
      rule?: string
    }
  | {
      kind: 'deny'
      rule: string
      /** Short, non-sensitive prose surfaced to Claude so the model
       *  knows why the tool call was rejected. */
      reason: string
    }
  | {
      kind: 'require'
      rule: string
      /** For now always the human approver; named so future expansion
       *  (peer-agent approvals, escalation paths) can extend the union. */
      approver: 'human_approver'
      /** How long an approval, once granted, is fresh for. Propagated
       *  from the matching `RequireApprovalRule.ttlMs`. */
      ttlMs: number
    }

// ---------------------------------------------------------------------------
// Path canonicalization (CWE-22) — see policy-evaluation-flow.md §174-196.
// ---------------------------------------------------------------------------

/** Canonicalize a `match.pathPrefix` at load time.
 *
 *  The policy loader calls this once per rule and caches the result.
 *  `realpathSync.native` resolves every symlink in the configured
 *  prefix, so the comparison at evaluate time is a prefix-check on
 *  two canonical paths — no TOCTOU, no smuggling.
 *
 *  Throws if the prefix does not exist on disk. That's intentional:
 *  a rule pointing at a nonexistent path can never match anything, so
 *  it's almost certainly a typo that the operator should fix at load
 *  time, not a mystery-miss at evaluation time. Fail loud.
 *
 *  See policy-evaluation-flow.md §174-196 for the full design rationale
 *  and CWE-22 mitigation story.
 */
export function canonicalizeRulePathPrefix(raw: string): string {
  return realpathSync.native(resolve(raw))
}

/** Canonicalize a per-call request path.
 *
 *  Unlike the prefix (canonicalized once at load), the input path is
 *  canonicalized on every tool call — fresh `realpath` each time so a
 *  newly-created symlink between calls is caught on the next match.
 *
 *  Throws if the path does not exist. That's the desired fail-closed
 *  posture: a tool call referencing a nonexistent path gets a policy
 *  error (loud) rather than matching a rule against an unresolvable
 *  lexical string (quiet).
 */
export function canonicalizeRequestPath(raw: string, cwd: string = process.cwd()): string {
  return realpathSync.native(resolve(cwd, raw))
}

/** Prefix-matches a canonicalized request path against a canonicalized
 *  rule prefix. Both args MUST already be realpath-resolved via the
 *  helpers above — this function does no I/O, just a string compare.
 *
 *  The `+ sep` guard prevents `/etc/passwd` from matching prefix
 *  `/etc/pass` while still allowing an exact-equality match (the common
 *  case of a rule targeting a file, not a directory).
 */
export function pathMatchesPrefix(resolvedPath: string, resolvedPrefix: string): boolean {
  return resolvedPath === resolvedPrefix || resolvedPath.startsWith(resolvedPrefix + sep)
}
