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

CI runs typecheck + tests on every push to main and every PR (`.github/workflows/ci.yml`).

## Key Files

- `server.ts` — MCP server runtime: bootstrap, Slack clients, tools, event handling
- `lib.ts` — pure functions: gate logic, security guards, text chunking, types
- `server.test.ts` — test suite covering security-critical functions (uses `bun:test`)
- `skills/configure/SKILL.md` — `/slack-channel:configure` token setup skill
- `skills/access/SKILL.md` — `/slack-channel:access` pairing/allowlist management skill
- `ACCESS.md` — access control schema documentation

## Security Architecture (critical context)

This is a prompt injection vector. Five defense layers:

1. **Inbound gate** (`gate()`) — drops ungated messages before MCP notification. Bot messages dropped by default; per-channel `allowBotIds` opts specific peer bots in. Self-echo detection matches on `bot_id` / `bot_profile.app_id` / `user === botUserId` to cover payload variants. `PERMISSION_REPLY_RE` is checked at the gate so peer bots cannot inject permission-reply text.
2. **Outbound gate** (`assertOutboundAllowed()`) — replies only to delivered channels
3. **File exfiltration guard** (`assertSendable()`) — blocks sending state dir files
4. **System prompt hardening** — instructions tell Claude to refuse pairing/access from messages. Peer-bot messages are flagged as carrying the same prompt-injection risk as human messages.
5. **Token security** — `.env` chmod 0o600, atomic writes, never logged

Any change to `gate()`, `assertSendable()`, or `assertOutboundAllowed()` is security-critical.

## State

All state lives in `~/.claude/channels/slack/`:
- `.env` — tokens (0o600)
- `access.json` — allowlist + pairing codes (0o600, atomic writes)
- `inbox/` — downloaded attachments

## Conventions

- MIT license
- Matches `anthropics/claude-plugins-official` patterns (file structure, naming, skills)
- Bun primary runtime, Node.js/Docker as alternatives
- TypeScript strict mode
- No external frameworks beyond the four declared runtime dependencies


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
