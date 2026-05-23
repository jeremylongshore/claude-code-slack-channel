# AGENTS.md — CCSC (claude-code-slack-channel)

This file is the cross-tool agent-instruction surface for this repo, following the
open [agents.md](https://agents.md) spec. It is read natively by Claude Code,
OpenAI Codex CLI, Cursor, Cline, Aider, Devin, Sourcegraph Amp, Gemini CLI,
Continue, Roo Code, Factory Droids, GitHub Copilot, Windsurf, and Amazon Q.

If you are an AI assistant helping a user with this repo, read this file FIRST.

## What this repo is

CCSC is a two-way Slack ↔ Claude Code bridge via Slack Socket Mode and MCP stdio.
A local TypeScript MCP server (Bun runtime) speaks Socket Mode to Slack and the
Model Context Protocol over stdio to a Claude Code session. The whole codebase
is a security substrate: every inbound message passes a five-layer prompt-injection
defense, every tool call is gated by a declarative policy engine, and every
decision is written to a hash-chained tamper-evident audit journal.

## If you're helping a new user install this

Run them through `/slack-channel:install` (the install skill at `skills/install/SKILL.md`).
That skill handles prerequisite checks, Slack app creation, the silent-killer
add-bot-to-channel step, token configuration (delegates to `/slack-channel:configure`),
pairing (delegates to `/slack-channel:access pair`), and a verification round-trip.

Do NOT make a new user read `CLAUDE.md` or the design docs in `000-docs/` first —
those are maintainer reference, not onboarding. Point them at `README.md` for
the human-readable quick start, and use the install skill for hand-holding.

## Critical setup gotchas (the silent killers)

These are the three failure modes that look like "the bot just doesn't work"
but are actually unstated prerequisites:

1. **Slack bot must be ADDED to the channel after app install.** Slack installs
   an app to a workspace WITHOUT joining any channels. The pairing DM works
   because DMs auto-route, but a channel test message will hit silence because
   the bot literally isn't in the channel to see the event. Fix: in Slack,
   open the channel → channel name → Integrations → Add an App → select the bot.
2. **Bun must be installed.** README Option B falls back to Node.js via npx,
   but requires editing `.mcp.json`. Default path is Bun; install from https://bun.sh.
3. **Claude Code v2.1.80+ with `claude.ai` login is required.** This is a
   Research Preview constraint — API-key-only auth does not work for Channels.
   If a user has `ANTHROPIC_API_KEY` set and no `claude.ai` session, the
   plugin fails to load with a non-obvious error.

## Build / test / dev commands

```bash
bun install                                          # Install deps
bun run typecheck                                    # tsc --noEmit
bun test --timeout 15000                             # Full suite (986+ tests)
bun test server.test.ts                              # Unit suite only
bun test features/runner.test.ts                     # Gherkin scenarios
bunx @biomejs/biome check .                          # Lint
bash scripts/coverage-floor.sh 95                    # 95% coverage gate
bun scripts/crap-score.ts --threshold 30             # Complexity gate (per-function)
bunx depcruise --config .dependency-cruiser.js .     # Architecture invariants
bash scripts/gherkin-lint.sh --path features/ --strict   # Wall 1 lint
bash scripts/harness-hash.sh --verify                # Tamper check
```

`bun server.ts` runs the MCP server directly. `claude --dangerously-load-development-channels server:slack`
runs it inside Claude Code in dev mode (bypasses plugin allowlist).

## Code style boundaries

- **TypeScript strict.** No `any` without explicit justification in a comment.
- **95% line + function coverage floor.** Enforced by `scripts/coverage-floor.sh`.
- **CRAP score per-function max 30.** Enforced by `scripts/crap-score.ts`.
- **Architecture invariants** (enforced by `.dependency-cruiser.js`):
  - `server.ts` MUST NOT import `manifest.ts` (31-A.4 invariant).
  - `journal.ts` MUST NOT import `policy.ts` (no-journal-imports-policy).
  - `admin.ts` MUST NOT import `manifest.ts` (no-admin-imports-manifest).
- Four runtime deps only: `@modelcontextprotocol/sdk`, `@slack/web-api`,
  `@slack/socket-mode`, `zod`. Adding a fifth needs explicit justification.

## Where things live

**Production source** (17 modules, all at repo root unless noted):

| File | Role |
|---|---|
| `server.ts` | Stateful runtime — Slack client bootstrap, MCP server, event handlers |
| `lib.ts` | Pure functions — `gate()`, `assertSendable()`, `assertOutboundAllowed()` |
| `journal.ts` | Hash-chained audit log + redactor |
| `supervisor.ts` | Session lifecycle (`SessionSupervisor`) |
| `policy.ts` | Policy engine (`evaluate`, shadow linter, monotonicity check) |
| `manifest.ts` | Bot-manifest protocol |
| `crypto.ts` | Ed25519 signing primitives |
| `acp-adapter.ts` | Agent-Communication-Protocol adapter |
| `policy-dispatch.ts` | Policy decision routing |
| `nonce-hitl.ts` | Nonce-bound human-in-the-loop approval |
| `admin.ts` | Admin command routing (gate → policy → journal → tmux) |
| `stream-reply.ts` | Streaming `chat.update` reply with single-finalize |
| `audit-key-loader.ts` | SOPS-decryption + boot-time audit-key load |
| `audit-key-cli.ts` | Operator CLI for audit-key init/rotate |
| `mute-store.ts` | `!mute` / `!unmute` peer-bot state |
| `peer-bot-rate-limit.ts` | Cross-bot message rate limit |
| `scripts/audit-key.ts` | Operator entry point for audit-key CLI |

**Tests**:
- `server.test.ts` — primary unit + integration suite (uses `bun:test`).
- `features/*.feature` — Wall 1 Gherkin acceptance contracts, pinned by `.harness-hash`.
- `features/runner.ts` + `features/runner.test.ts` + `features/steps/*.ts` —
  hand-rolled Gherkin runner.

**Design docs** (`000-docs/`):
- `THREAT-MODEL.md` — trust boundaries, T1–T10 threats, invariants.
- `audit-journal-architecture.md` — hash chain, redaction, verify command.
- `policy-evaluation-flow.md` — `evaluate()` decision procedure.
- `session-state-machine.md` — supervisor contract + lifecycle.
- `bot-manifest-protocol.md` — manifest schema + "advertisements are not grants".
- `key-management.md` — Ed25519 audit-key lifecycle (SOPS, init, rotate).
- `multi-agent-channels.md` — cross-bot recipe (`allowBotIds`, `!mute`).
- `ADR-001-capability-token-format.md` — capability-token format evaluation.

## What NOT to do

- **Don't propose new code without checking if a sibling-module primitive
  already exists.** 17 modules cover most concerns. `bd search <keyword>`
  finds historical decisions.
- **Don't write into `server.ts`.** Pure logic goes in `lib.ts` or a new
  sibling module. `server.ts` is for stateful wiring (Slack client, MCP
  server, event listeners, file I/O).
- **Don't bypass the inbound gate / outbound gate / file exfiltration guard.**
  These are the five-layer security architecture — `gate()`,
  `assertOutboundAllowed()`, `assertSendable()` in `lib.ts`. Changes to
  any of these are security-critical.
- **Don't propose new design docs without a paired bd.** All non-trivial
  work is bead-tracked.
- **Don't modify `CLAUDE.md`.** That's the maintainer's private reference,
  not user-facing guidance.
- **Don't add a 5th runtime dependency without explicit justification.**

## How to verify work

```bash
bun run typecheck                                    # No errors
bun test --timeout 15000                             # 986+ tests pass
bunx @biomejs/biome check .                          # Lint clean
bash scripts/coverage-floor.sh 95                    # Coverage ≥ 95%
bun scripts/crap-score.ts --threshold 30             # No function over 30
bunx depcruise --config .dependency-cruiser.js .     # No architecture violations
```

The CI workflow `ci.yml` runs nine gates in this order: typecheck → Biome lint
→ test → coverage floor → depcruise → gherkin-lint → harness-hash verify →
`bun audit` → crap-score. All must pass to merge.

## Repo conventions

- **Feature branches always.** Never push to main directly. Branch naming:
  `feat/<description>-bz-<bead-id>` for features, `fix/<...>-bz-<bead>` for
  bugs, `docs/<...>-bz-<bead>` for docs-only.
- **One PR per logical unit.** Don't bundle unrelated changes.
- **Gemini auto-reviews PRs.** Round-1 findings are usually legitimate.
  Address with fix-up commits — never force-push to "clean up" a PR.
- **Required CI**: `Typecheck` is the required status check with `strict: true`.
- **`bd close <id> -r "<evidence>"`** when work ships. Evidence = PR number,
  commit SHA, and what was verified (tests, lint, CI).

## See also

- [`README.md`](README.md) — human-facing quick start.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — full contributor guide (branching,
  commits, PR workflow, quality gates, security-sensitive code).
- [`skills/install/SKILL.md`](skills/install/SKILL.md) — fresh-clone install
  walkthrough (delegate new users here).
- [`skills/configure/SKILL.md`](skills/configure/SKILL.md) — token configuration.
- [`skills/access/SKILL.md`](skills/access/SKILL.md) — pairing + allowlist.
- [`skills/policy/SKILL.md`](skills/policy/SKILL.md) — policy-rule authoring.
- [`ACCESS.md`](ACCESS.md) — full access-control schema.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — component diagram, four-principal model.
- [`SECURITY.md`](SECURITY.md) — security policy + vulnerability reporting.
- `000-docs/` — design docs (read BEFORE touching any subsystem they cover).
