# ADR-004: Positioning vs Claude Tag, and the Block Kit adopt/hybridize/keep decision

## Status

**ACCEPTED** — `ccsc-pko.3` (decision), closing the evaluation epic `ccsc-pko`
(#212). This is a **decision-record spike, not a build**: it benchmarks CCSC
against the shipped Claude Tag surface, fixes the product positioning, and
decides what to do about Block Kit. No code ships from this ADR.

**Amended 2026-07-13** (`ccsc-37k`) — see [Amendment — Decision 2a](#amendment-2026-07-13--decision-2a-interactive-block-kit-output-is-in-scope):
interactive Block Kit *output* on the `reply` tool is recorded as in-scope, under
a `portable ∧ journaled ∧ non-native-coupled` bright line. Triggered by the #270
review (`ccsc-ysu`).

## Context

On 2026-06-23 Anthropic shipped **Claude Tag** — first-party `@Claude` in Slack:
a persistent teammate with per-channel scope, a viewable audit log, token-spend
caps, and "learns your company" memory (Team/Enterprise beta). The two loudest
market criticisms of Tag — **runaway cost** and **data sovereignty / governance**
— are exactly CCSC's lane. `ccsc-pko` was opened to evaluate Slack's native
agentic surface; the 2026-06-23 re-scope re-pointed it at the *shipped* Tag
surface. This ADR is that evaluation's decision.

The trap to avoid (per [`../ROADMAP.md`](../ROADMAP.md) Non-Goals): **do not
chase feature-parity with Tag.** Tag is a first-party, hosted, learning product
with a team behind it. CCSC cannot and should not out-feature it. CCSC's product
*is* scope discipline — the most trustworthy, auditable, correct kernel, small
enough to read in an afternoon and verify.

## Benchmark — CCSC vs Claude Tag

| Dimension | Claude Tag | CCSC | Who wins, for whom |
|---|---|---|---|
| **Hosting / data** | Anthropic-hosted; messages + memory leave your boundary | Self-hosted; runs on your box, no third party in the loop | CCSC for data-sovereignty / air-gapped / regulated |
| **Audit** | *Viewable* log in Slack (Anthropic's record, Anthropic's retention) | Hash-chained, **Ed25519-signed, offline-verifiable** journal; `verifyJournal` recomputes the same answer on any machine, with pinned-genesis / v2-floor anchors (`ccsc-x0t.7`) that defeat head-truncation + downgrade | CCSC when you must **prove** what the agent did, offline, to a third party |
| **HITL / approval** | Approval previews in Slack UI | **Per-tool-call** gate via a pure `evaluate()`; deterministic policy rules; **HMAC-nonce + cross-channel** confirmation for destructive verbs; fail-safe-to-human when a predicate can't be evaluated (`ccsc-x0t.5`) | CCSC when you need deterministic, replayable, per-call authorization |
| **Cost control** | First-party token-spend caps (real metering) | Lower-bound *advisory* cap as ordinary policy rules (no model key → can't meter dollars); journaled as exactly advisory | **Tag** for precise dollar caps; CCSC for *governing the decision* around cost |
| **Scope model** | Per-channel | Per-channel + per-thread + per-actor + per-tool + per-arg policy, tiered (admin > user > workspace > default) | CCSC for fine-grained governance |
| **Learning / memory** | "Learns your company" (adaptive) | **None by design** — a learned gate can't be replayed to prove which rules were in force (see the yun520-1 / #247 thread) | Tag for convenience; CCSC for auditability |
| **Surface area** | Large, first-party, opaque | ~17 source files, ~13k LoC, Apache-2.0, one afternoon to audit | CCSC when "I can read and trust the whole thing" is the requirement |

## Decision 1 — Positioning

> **Choose CCSC when you need to *prove* what the agent did — offline,
> self-hosted, to a third party — and to govern each tool call deterministically.
> Choose Tag when you want a hosted, learning, low-setup teammate and precise
> dollar caps, and you're comfortable with a first-party record.**

CCSC is not "open-source Tag." It is the **governance kernel** you reach for when
the audit trail is load-bearing (compliance, incident forensics, multi-party
trust) and when the runtime must stay on your infrastructure. The signed
offline-verifiable journal is the single most differentiating asset — Tag's log
is *viewable*; CCSC's is *provable*. Everything the hardening epic (#269) just
shipped sharpens exactly that claim.

This positioning is the one-liner for the README / landing and the frame for any
Tag comparison: **viewable vs provable; hosted vs sovereign; learning vs
replayable.**

## Decision 2 — Block Kit: **KEEP** (do not adopt Tag's / Slack's newer native components yet)

The evaluation asked adopt / hybridize / keep for the approval + receipt UI
(`ccsc-pko.1`/`.2`). **Decision: KEEP the current Block Kit HITL + audit
projection**, for now, because:

1. **Block Kit is the portable floor.** It works on every Slack tier without a
   dependency on Tag-era native components or an Agent-Browser surface that not
   all workspaces have. A governance kernel should assume the *least* capable
   host.
2. **Adopting native components would couple the kernel to a moving first-party
   surface** — the opposite of the small-and-verifiable value. Every UI
   primitive we adopt is a thing that can change under us.
3. **The mention-to-engage UX (`ccsc-apj`) already made the existing surface
   usable** ("mention once, then converse"), which was the prerequisite the
   re-scope named. The approval flow is not the weak point.
4. **The differentiator is the *record*, not the *widget*.** Investing in
   prettier approval cards chases Tag's polish (a losing game); investing in the
   signed journal + policy engine deepens the moat.

**Hybridize later, conditionally.** If a specific native component is (a)
available on the tiers our users run and (b) strictly additive to the audit
*projection* (never the authoritative journal), it can be adopted behind the
existing `ChannelPolicy.audit` control — e.g. rendering an audit summary as a
Slack Canvas (`ccsc-ogq.1`, #247) is a reasonable *projection* enhancement
because it never touches the signed record. That is tracked separately and is
not gated on this ADR.

## Amendment (2026-07-13) — Decision 2a: interactive Block Kit **output** is in scope

**Status of this amendment: ACCEPTED** (`ccsc-37k`). Triggered by the 360°
review of a cold-contributor proposal — interactive option buttons on the
`reply` tool plus a gated, journaled inbound click relay (issue #270, review bead
`ccsc-ysu`). The review found the feature is genuine operator value and
architecturally sound (pure-function-forward, journaled on both drop and deliver,
composes with the policy engine, does not touch the manifest-isolation boundary).
It surfaced that Decision 2 above did not actually speak to this surface — and
that leaving it silent was itself a drift risk (the next contributor could cite
ADR-004 *for* or *against* interactive output with no bright line). This
amendment records the missing decision.

**Decision 2 was narrow.** It answered adopt/hybridize/keep for the **approval +
receipt UI** (`ccsc-pko.1`/`.2`) — specifically whether to adopt *Tag-era native
components* for the HITL widget — and it decided KEEP Block Kit, framing the
differentiator as *"the record, not the widget."* Interactive **output** on the
`reply` tool (agent-authored option buttons whose clicks return as journaled
inbound events) is a **different surface**. Decision 2 neither authorized nor
forbade it.

**Decision 2a: interactive Block Kit *output* is IN SCOPE**, because it satisfies
the same reasoning that produced Decision 2 rather than contradicting it:

1. **Portable floor, not native components.** It uses standard Block Kit —
   exactly the "assume the least-capable host" principle of Decision 2 reason #1.
   It adds **no** dependency on Tag-era native components.
2. **It strengthens the record, not the widget.** Every click is identity-gated
   and **journaled on drop and deliver**, so the feature *deepens* the signed
   provable-record moat (Decision 2 reason #4) instead of chasing approval-card
   polish.
3. **No feature-parity roadmap with Tag** is created or implied.

**Bright line (the scope boundary for the next ask).** This blesses *interactive
output only*. The test for any future interactive primitive is **portable ∧
journaled ∧ not-native-component-coupled**. Each further primitive — modals,
select/multi-select menus, external-data sources, or Tag-native components —
requires its **own** decision; the kernel does not commit to matching Tag's
interactive-teammate surface generally.

**Honest cost of this amendment.** It softens Decision 2's *"record, not widget"*
purity — it concedes that *some* widget investment is worthwhile when the widget
is portable, journaled, and non-native-coupled. That is a **refinement, not a
reversal**: the signed record stays the moat, and every interaction this blesses
lands in it. The cost of *not* amending is worse — an unwritten precedent that
invites exactly the feature-parity creep the ADR exists to forbid.

The #270 feature is **accept-with-conditions**, not yet merged; the merge
conditions (completing the reserved-namespace guard, routing channel lookups
through `getChannelPolicy`, the outbox downgrade contract, and the threat-model /
journal doc updates) are tracked on `ccsc-ysu` and are independent of this scope
decision.

## Consequences

- `ccsc-pko.1` (approval-preview spike) and `ccsc-pko.2` (native-component
  receipts prototype) are **resolved as "evaluated, keep Block Kit"** — no
  prototype ships; the finding is the decision above. Re-open only if a concrete
  user need for a native component appears on a tier we support.
- The positioning statement (Decision 1) is the canonical framing for the Tag
  comparison; feed it into the README/landing and any competitive one-pager.
- Cost control stays as the #247 spend-cap-as-policy work (advisory lower-bound,
  no new primitive) — this ADR only records that precise dollar metering is
  **Tag's** win and out of CCSC's scope by design (no model key). The smarter
  cost-router / provider-failover ideas route to **AGP** (per the yun520-1 thread
  on #247).
- No feature-parity roadmap with Tag is created. That is the point.
- **(Amendment 2026-07-13)** Interactive Block Kit *output* is in scope under the
  `portable ∧ journaled ∧ non-native-coupled` bright line (Decision 2a). Each
  further interactive primitive (modals, selects, native components) still needs
  its own decision. The #270 feature that triggered this is accept-with-conditions
  (`ccsc-ysu`), not a parity commitment.

## Related

- [`../ROADMAP.md`](../ROADMAP.md) — Vision + Non-Goals (scope discipline).
- `000-docs/audit-journal-architecture.md` — the signed offline-verifiable
  journal + `ccsc-x0t.7` anchors that anchor the "provable" claim.
- `000-docs/policy-evaluation-flow.md` — the deterministic per-tool-call gate.
- #247 (`ccsc-ogq`) — spend-cap-as-policy + Canvas projection (the cost + output
  differentiators; separate work).
- #212 (`ccsc-pko`) — this evaluation epic.
- #270 + `ccsc-ysu` — the interactive-output proposal + its 360° review that
  triggered the 2026-07-13 amendment (Decision 2a); `ccsc-37k` — the amendment.
- AT-DECR 013 (private) — the peer-runtime-audit decision record this epic traces
  to; no peer brand named here by design.
