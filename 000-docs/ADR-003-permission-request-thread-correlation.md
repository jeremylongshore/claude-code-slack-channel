# ADR-003: Thread correlation for policy evaluation of MCP permission requests

## Status

**ACCEPTED (operating assumption) + DEFERRED (implementation)** — `ccsc-x0t.6`,
epic #269. The literal fix the bead asked for ("`evaluate()` receives the
originating thread of the specific tool call, not a global") is **not achievable
within CCSC** at the current MCP surface — the data does not exist in-band. This
ADR records that finding, the single-active-thread operating assumption we adopt
in the meantime, the fail-safe mitigation design to implement if evidence
warrants, and the upstream ask that would enable the real fix.

## Context

The sole production caller of `policy.evaluate()` is the MCP `permission_request`
notification handler (`server.ts`). It builds the `ToolCall` with:

```ts
const sessionThread = lastActiveThread ?? ''
const policyCall = {
  tool: params.tool_name,
  sessionKey: { channel: targetChannel, thread: sessionThread },
  actor: 'claude_process',
  input: {}, inputAvailable: false,   // see ADR / policy-evaluation-flow.md § Input-unavailable fail-safe (ccsc-x0t.5)
}
```

`lastActiveThread` (and `lastActiveChannel` / `targetChannel`) are **module-level
globals reassigned on every inbound Slack message** — they hold the *most-recent
inbound* thread, not the thread that owns *this* tool call. Under interleaved
multi-thread activity, a `permission_request` can be attributed to the wrong
thread:

- A `{ auto_approve, thread_ts: A }` rule can fire for a tool call that
  originated in thread B (over-grant).
- A `{ deny, thread_ts: Q }` quarantine can silently fail to fire when
  `lastActiveThread` has moved off Q (under-enforcement).

`ccsc-x0t` (#264) *narrowed* the prior global-match hole (thread_ts is now
enforced in `matchApplies`), which paradoxically makes the racy global
**load-bearing**: a thread-scoped rule now depends on `lastActiveThread` pointing
at the right thread.

## The feasibility finding (why the literal fix is blocked)

The originating thread of a specific tool call is **not transmitted to the
bridge**. Concretely:

1. **The notification carries no correlation.** The `permission_request`
   notification schema (`server.ts`) is exactly
   `{ request_id, tool_name, description, input_preview }` — no thread, no
   channel, no session id.
2. **`pendingPermissions` is keyed by the same racy global.** It is keyed via
   `permissionPairingKey(lastActiveThread, request_id)`, so it provides no
   *independent* thread correlation — it is built from the global we are trying
   to replace.
3. **There is no prior `request_id → thread` map.** The `permission_request` is
   the first time the bridge sees that `request_id`; the causal link between
   "Claude decided to call a tool" and "which Slack thread prompted it" lives
   only inside Claude Code's process context, which the bridge cannot read.

So there is no in-band signal from which `evaluate()` could recover the tool
call's true origin thread. The same limitation applies to the *channel*
(`targetChannel` derives from the same global). This is an **architectural
constraint of the current MCP permission surface**, not an oversight in CCSC.

## Options considered

**A. Single-active-thread operating assumption (accept + document).**
Treat the bridge as correct *only* when at most one thread is actively driving
tool calls at a time — the overwhelmingly common case for a single-operator
channel. Document the limitation in the threat model. Zero code, zero new
mechanism. Risk: silent misattribution under genuine concurrent multi-thread
tool-calling.

**B. Upstream notification-shape change (the real fix).**
Ask Anthropic to include a session/thread correlation token in the
`permission_request` notification (or a stable `request_id → session` mapping the
bridge can observe *before* the permission request). Then `evaluate()` receives
the true origin. This is the only path to precise per-thread governance under
concurrency — but it is **out of CCSC's control** (a Claude Code change).

**C. Multi-thread-ambiguity fail-safe (the mitigation).**
Track threads that produced inbound activity within the permission window. When
**more than one** thread is active and a matched rule is *thread-scoped*, the
attribution is unreliable → treat the thread predicate as **indeterminate** and
**fail safe to a human** (route to approval), reusing the exact machinery from
`ccsc-x0t.5` (the input-unavailable fail-safe). Channel-scoped and tool-scoped
rules are unaffected. Cost: added runtime state (a short-window active-thread
set) and possible extra HITL prompts during legitimate bursts of multi-thread
activity.

## Decision

1. **Adopt Option A as the operating assumption now**, documented here and as a
   named limitation in `THREAT-MODEL.md`. CCSC's per-thread governance is precise
   under single-active-thread operation (the common case) and is honest that it
   degrades under concurrent multi-thread tool-calling.
2. **Specify Option C as the chosen mitigation** (design above) and **defer its
   implementation** until there is evidence of real concurrent multi-thread
   misattribution, OR Option B does not materialize. We deliberately do **not**
   ship speculative runtime state + extra HITL prompts to guard a case we have no
   evidence occurs in practice — kernel-smallness beats a mechanism that adds
   footguns for partial protection. If/when implemented, it composes with the
   existing `indeterminate` decision path (no new decision kind).
3. **File Option B upstream** as the durable fix — the ask is a
   session/thread correlation field on the `permission_request` notification.
   (Left to the maintainer to file on `anthropics/claude-code` — a public
   feature request on Anthropic's repo is an outward action to author
   deliberately, not automate.)

**Chose "document + defer the mitigation" over "implement Option C now"** because
the mitigation trades real UX cost (false HITL prompts on legitimate bursts) for
protection against a failure mode we have not observed, and the *complete* fix is
upstream regardless. Documenting the boundary honestly is the higher-integrity
move than a heuristic that papers over it.

## Consequences

- **Residual risk (accepted, documented):** under genuine concurrent
  multi-thread tool-calling, a thread-scoped `auto_approve` may fire for the
  wrong thread (over-grant) or a thread-scoped `deny`/`require` may miss
  (under-enforcement). Channel-, tool-, actor-, and arg-scoped rules are
  unaffected; the human approver still sees every `require`/Block-Kit prompt in
  *some* thread and can refuse. The signed journal records the (possibly-wrong)
  `sessionKey` faithfully, so misattribution is *auditable after the fact*.
- **When the assumption holds** (single active thread — the common single-
  operator case), per-thread governance is precise.
- **Trigger to implement Option C:** a reproduced case of concurrent
  multi-thread misattribution, or a decision that Option B will not land.
- **Trigger to implement Option B's consumption:** the notification gains a
  correlation field; then `sessionThread`/`targetChannel` are read from the
  notification and this whole class closes.

## Related

- `000-docs/policy-evaluation-flow.md` § Input-unavailable fail-safe — the
  `indeterminate` machinery Option C reuses.
- `000-docs/THREAT-MODEL.md` — the thread-attribution limitation (added with
  this ADR).
- `ccsc-x0t.5` — the fail-safe pattern; `ccsc-x0t.1` — thread_ts in the subset
  linters.
- Bead `ccsc-x0t.6` (this ADR) under epic #269.
