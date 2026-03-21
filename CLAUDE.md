# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Slack channel for the Claude Code — two-way chat bridge via Socket Mode + MCP stdio.

## Architecture

Two-file MCP server: `server.ts` (stateful runtime, ~630 lines) and `lib.ts` (pure functions, ~260 lines). Three dependencies: `@modelcontextprotocol/sdk`, `@slack/web-api`, `@slack/socket-mode`. No frameworks.

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
bun server.ts            # Run server directly
npx tsx server.ts        # Node.js fallback
```

## Key Files

- `server.ts` — MCP server runtime: bootstrap, Slack clients, tools, event handling
- `lib.ts` — pure functions: gate logic, security guards, text chunking, types
- `server.test.ts` — test suite covering security-critical functions (uses `bun:test`)
- `skills/configure/SKILL.md` — `/slack-channel:configure` token setup skill
- `skills/access/SKILL.md` — `/slack-channel:access` pairing/allowlist management skill
- `ACCESS.md` — access control schema documentation

## Security Architecture (critical context)

This is a prompt injection vector. Five defense layers:

1. **Inbound gate** (`gate()`) — drops ungated messages before MCP notification
2. **Outbound gate** (`assertOutboundAllowed()`) — replies only to delivered channels
3. **File exfiltration guard** (`assertSendable()`) — blocks sending state dir files
4. **System prompt hardening** — instructions tell Claude to refuse pairing/access from messages
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
- No external frameworks beyond the three declared dependencies
