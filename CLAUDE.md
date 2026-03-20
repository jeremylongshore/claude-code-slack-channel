# CLAUDE.md

## What This Is

Slack channel for Claude Code — two-way chat bridge via Socket Mode + MCP stdio. First `claude/channel` implementation for Slack.

## Architecture

Single-file MCP server (`server.ts`, ~850 lines). Three dependencies: `@modelcontextprotocol/sdk`, `@slack/web-api`, `@slack/socket-mode`. No frameworks.

```
Slack workspace → Socket Mode WebSocket → server.ts → MCP stdio → Claude Code
```

## Commands

```bash
bun install              # Install deps
bun run typecheck        # TypeScript strict check (tsc --noEmit)
bun server.ts            # Run server directly
npx tsx server.ts        # Node.js fallback
```

## Key Files

- `server.ts` — entire MCP server: bootstrap, gate, tools, event handling
- `skills/configure/SKILL.md` — `/slack:configure` token setup skill
- `skills/access/SKILL.md` — `/slack:access` pairing/allowlist management skill
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
