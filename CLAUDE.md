# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Slack channel for the Claude Code — two-way chat bridge via Socket Mode + MCP stdio.

## Architecture

Two-file MCP server: `server.ts` (stateful runtime, ~1000 lines) and `lib.ts` (pure functions, ~460 lines). Four runtime dependencies: `@modelcontextprotocol/sdk`, `@slack/web-api`, `@slack/socket-mode`, `zod`. No frameworks.

```
Slack workspace → Socket Mode WebSocket → server.ts → MCP stdio → Claude Code
```

**`lib.ts`** contains all pure, testable logic: `gate()`, `assertSendable()`, `assertOutboundAllowed()`, `chunkText()`, `sanitizeFilename()`, types, and constants. Side-effect-free — accepts dependencies as parameters.

**`server.ts`** imports from `lib.ts` and handles stateful concerns: Slack client bootstrap, token loading, MCP server registration, event listeners, file I/O. When adding logic, put pure functions in `lib.ts` and keep `server.ts` for wiring.

## Commands

```bash
bun install              # Install deps
bun run typecheck        # TypeScript strict check (tsc --noEmit)
bun test                 # Run test suite (bun:test)
bun test --watch         # Watch mode
bun test --grep "gate"   # Run tests matching a pattern
bun server.ts            # Run server directly
npx tsx server.ts        # Node.js fallback
```

Dev mode (bypasses plugin allowlist):
```bash
claude --dangerously-load-development-channels server:slack
```

CI workflows (`.github/workflows/`):
- `ci.yml` — Typecheck (required by branch protection) + test suite on push/PR to main.
- `codeql.yml` — CodeQL security scan.
- `gemini-review.yml` — automated PR review.
- `scorecard.yml` — OpenSSF Scorecard.
- `notify-marketplace.yml` — marketplace notification on release.

## Merging PRs

Main is branch-protected: `Typecheck` is a required status check and `strict: true` (each PR must be up-to-date with main before merging). You have admin rights:

```bash
gh pr merge <N> --squash --admin --delete-branch
```

When merging multiple PRs in sequence, `strict: true` will re-demand Typecheck against the new main for every later PR in the queue. Temporarily drop strict, merge, restore:

```bash
echo '{"strict":false,"contexts":["Typecheck"]}' | gh api -X PATCH repos/jeremylongshore/claude-code-slack-channel/branches/main/protection/required_status_checks --input -
# merge your PRs
echo '{"strict":true, "contexts":["Typecheck"]}' | gh api -X PATCH repos/jeremylongshore/claude-code-slack-channel/branches/main/protection/required_status_checks --input -
```

## Key Files

- `server.ts` — MCP server runtime: bootstrap, Slack clients, tools, event handling
- `lib.ts` — pure functions: gate logic, security guards, text chunking, session types
- `policy.ts` — Zod schema for PolicyRule (29-A.1 landed; evaluator lands in follow-up beads)
- `server.test.ts` — test suite covering security-critical functions (uses `bun:test`)
- `skills/configure/SKILL.md` — `/slack-channel:configure` token setup skill
- `skills/access/SKILL.md` — `/slack-channel:access` pairing/allowlist management skill
- `ACCESS.md` — access control schema documentation

## Design Docs (load-bearing contracts)

The design-in-public commitment: the doc ships before the code, and the doc is the source of truth for security-boundary decisions. Read the matching doc before touching its subsystem — a PR that contradicts a frozen doc is a revert, not a merge.

- `ARCHITECTURE.md` — top-level component diagram, four-principal model.
- `000-docs/THREAT-MODEL.md` — trust boundaries, attack surface per primitive, T1–T10 threats, invariants.
- `000-docs/session-state-machine.md` — `SessionKey`, supervisor contract, lifecycle (Epic 32-A/B).
- `000-docs/policy-evaluation-flow.md` — `evaluate()` decision procedure, shadow linter, monotonicity (Epic 29-A/B).
- `000-docs/audit-journal-architecture.md` — hash-chain, redaction, verify command (Epic 30-A/B).
- `000-docs/bot-manifest-protocol.md` — manifest schema, "advertisements are not grants" invariant (Epic 31-A/B).

When a design doc and code disagree, the code is wrong.

## Security Architecture (critical context)

This is a prompt injection vector. Five defense layers:

1. **Inbound gate** (`gate()`) — drops ungated messages before MCP notification. Bot messages dropped by default; per-channel `allowBotIds` opts specific peer bots in. Self-echo detection matches on `bot_id` / `bot_profile.app_id` / `user === botUserId` to cover payload variants. `PERMISSION_REPLY_RE` is checked at the gate so peer bots cannot inject permission-reply text.
2. **Outbound gate** (`assertOutboundAllowed()`) — replies only to delivered channels
3. **File exfiltration guard** (`assertSendable()`) — blocks sending state dir files (`.env`, `access.json`, `sessions/`, future `audit.log`). State-dir layout and per-thread session files are specified in [`000-docs/session-state-machine.md`](000-docs/session-state-machine.md) (Epic 32-A).
4. **System prompt hardening** — instructions tell Claude to refuse pairing/access from messages. Peer-bot messages are flagged as carrying the same prompt-injection risk as human messages.
5. **Token security** — `.env` chmod 0o600, atomic writes, never logged

Any change to `gate()`, `assertSendable()`, or `assertOutboundAllowed()` is security-critical.

## State

All state lives in `~/.claude/channels/slack/` (files `0o600`, directories `0o700`, single-writer):
- `.env` — tokens (0o600)
- `access.json` — allowlist + pairing codes (0o600, atomic writes)
- `inbox/` — downloaded attachments
- `sessions/<channel>/<thread>.json` — per-thread conversation state (v0.5.0+). Migrated flat pre-0.5.0 files surface as the `default` thread. See [`000-docs/session-state-machine.md`](000-docs/session-state-machine.md) for the layout spec, lifecycle state machine, and supervisor contract; operator-facing docs in [`ACCESS.md`](ACCESS.md#state-directory-layout).

## Conventions

- MIT license
- Matches `anthropics/claude-plugins-official` patterns (file structure, naming, skills)
- Bun primary runtime, Node.js/Docker as alternatives
- TypeScript strict mode
- No external frameworks beyond the four declared runtime dependencies
- Epic / sub-epic titles read like English sentences, not code. Leaf bead titles can stay technical. `ccsc-v1b: Build the policy engine's core logic` ✓, not `29-A.Eval: evaluate() + load-time safety` ✗.
- Issues → 2–5 themed epics (A/B split + sub-epics when >5 children). Don't ship one flat epic with 10 children.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd backup export-git   # pushes a snapshot to origin/beads-backup for cross-machine recovery
   git push
   git status  # MUST show "up to date with origin"
   ```
   (`bd dolt push` is only for projects with a Dolt remote configured via `bd dolt remote add`; this repo uses the git-branch backup path instead.)
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
