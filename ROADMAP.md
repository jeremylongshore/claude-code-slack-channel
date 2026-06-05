# Roadmap

This document states **what CCSC is for, where it's going, and — just as
importantly — what it is deliberately *not*.** If you're considering a
contribution, read the **Non-Goals** section first: it will save you (and the
maintainer) from a large PR that can't be merged because it points the project
in a direction it isn't going.

CCSC is a solo-maintained project with a deliberately narrow charter. "Narrow"
is a feature, not a limitation — see [§ Vision](#vision).

## Vision

**CCSC is the Slack-native governance *substrate* for Claude Code — a small,
auditable kernel, not a kitchen sink.** Humans, Claude Code sessions, and peer
agents converse in shared Slack channels, and every tool call passes through a
tiered policy engine and lands in a hash-chained, Ed25519-signed audit journal
you can verify offline.

The kernel — the policy engine (`policy.ts`), the signed journal (`journal.ts`),
the Slack relay, nonce-bound HITL — is intended to stay **small enough to read in
an afternoon and trust.** It is the substrate that downstream governance tooling
(notably the companion **[agent-governance-plane](https://github.com/jeremylongshore/agent-governance-plane)**)
vendors as a dependency. Every line we *don't* add to the kernel is a line a
downstream consumer doesn't have to audit. Scope discipline is the product.

## Current focus

Work is tracked as epics in GitHub issues + the in-repo `bd` (beads) tracker.
The live tracks, in priority order:

| Epic | Theme | What it means |
|---|---|---|
| [#208](https://github.com/jeremylongshore/claude-code-slack-channel/issues/208) | **Crash-safety & loss-proof replies** | Make a terminal turn's reply survive a process crash or a transient Slack failure instead of being silently dropped. |
| [#210](https://github.com/jeremylongshore/claude-code-slack-channel/issues/210) | **Security regression tests** | Turn known footguns into permanent fail-closed regression tests (cross-thread isolation, gapless audit, fail-open defaults). |
| [#212](https://github.com/jeremylongshore/claude-code-slack-channel/issues/212) | **Evaluate native Slack approval primitives** | Spike Slack's native agent-approval / interactive components against the existing nonce-HITL flow; decide adopt / hybridize / keep. |

The through-line is the same: **harden the one thing we have.** New work is
weighed against "does this make the single-process substrate more correct,
more secure, or easier to trust?"

## Non-Goals

These are out of scope **by design.** A PR implementing one of these will be
closed with a pointer back here — not because the work is bad, but because it
belongs somewhere else. If you think a non-goal should change, open an issue to
make the case *before* writing code (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

- **Multi-process / multi-session / multi-runtime orchestration.** CCSC is
  **single-process by design** — Claude Code spawns exactly one bridge over MCP
  stdio. Routers, supervisor daemons, multiple Claude sessions behind one Slack
  app, and cross-runtime governance are **not** CCSC's job. That is precisely
  what the companion **[agent-governance-plane (AGP)](https://github.com/jeremylongshore/agent-governance-plane)**
  exists to do — it vendors this kernel and wraps multiple sandboxed agent
  sessions over a gateway. **If you want multi-session, that conversation belongs
  on AGP.** Making the substrate itself multi-process would blur the clean
  vendor boundary AGP depends on and create two competing orchestration models in
  one ecosystem.
- **Non-Slack channels** (Discord, Telegram, Teams, a web UI, …). CCSC is
  Slack-native on purpose; a generic multi-channel abstraction is a different
  product.
- **Owning an agent runtime / model access.** CCSC reuses the operator's Claude
  Code login and holds no Anthropic API key. It governs the conversation; it does
  not run the model.
- **A plugin/extension framework.** The four-principal model and the security
  boundary are fixed and auditable. Arbitrary third-party plugins inside the trust
  boundary are a non-goal — extension happens *downstream* of the kernel, not
  inside it.
- **Feature breadth over kernel smallness.** When a feature and "keep the kernel
  small and auditable" conflict, the kernel wins. Convenience features that bloat
  the trust surface are declined.

## How decisions get made

CCSC follows a **design-in-public** discipline: for security-boundary changes,
the design doc (in `000-docs/`) ships *before* the code and is the source of
truth — a PR that contradicts a frozen design doc is a revert, not a merge. See
[`ARCHITECTURE.md`](ARCHITECTURE.md), [`000-docs/THREAT-MODEL.md`](000-docs/THREAT-MODEL.md),
and the per-subsystem design docs.

## Contributing against this roadmap

The single most useful thing a contributor can do is **open an issue before a
substantial PR** so we can agree the work is on-roadmap *before* you invest in
it. Roadmap-aligned hardening work (the epics above) is very welcome; off-roadmap
re-architectures are not, no matter how well-built. Full conventions:
[`CONTRIBUTING.md`](CONTRIBUTING.md).
