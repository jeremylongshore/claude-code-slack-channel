# claude-code-slack-channel v0.1.0

Two-way Slack channel for Claude Code — chat from Slack DMs and channels, just like the terminal.

The first `claude/channel` implementation for Slack. Uses Socket Mode (outbound WebSocket, no public URL) to bridge Slack messages into a running Claude Code session via MCP stdio. Five defense layers prevent prompt injection, token exfiltration, and unauthorized access. Three runtime options: Bun, Node.js, Docker.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://github.com/jeremylongshore/claude-code-slack-channel/blob/main/LICENSE)

**Links:** [GitHub](https://github.com/jeremylongshore/claude-code-slack-channel)

---

## One-Pager

### The Problem

If you're using Claude Code, you're chained to the terminal. Step away from your desk and the conversation stops. Your phone has Slack — but Slack can't talk to your Claude session.

Anthropic shipped channels for Telegram, Discord, and a localhost demo (fakechat), but nothing for Slack — the tool most teams already live in. The existing Slack plugin in the official repo is a tool server: Claude can post to Slack, but Slack can't talk back. It's one-way.

Meanwhile, the channel protocol (`claude/channel`) is new and underdocumented. The community hasn't built a Slack channel either. If you want to DM your Claude session from Slack, nothing exists to do it.

### The Solution

A single-file MCP server (~850 lines TypeScript) that connects Slack to Claude Code bidirectionally. Inbound messages arrive via Socket Mode (Slack's outbound WebSocket — no public URL, no webhook endpoint, works behind any firewall). Outbound replies go through the Slack Web API. Everything runs locally as a subprocess of Claude Code.

The architecture mirrors the official Discord channel exactly — same gate/pairing/allowlist pattern — adapted for Slack's APIs (timestamps as message IDs, mrkdwn instead of Markdown, dual tokens, `files.uploadV2`). Security is defense-in-depth: inbound gate drops ungated messages before MCP, outbound gate restricts replies, file exfiltration guard blocks state directory leaks, and system prompt hardening tells Claude to refuse manipulation attempts from messages.

### Who / What / Where / When / Why

| Aspect | Details |
|--------|---------|
| **Who** | Developers using Claude Code who collaborate via Slack |
| **What** | MCP channel server — pushes Slack events into Claude Code sessions, replies back |
| **Where** | Runs locally (your machine), connects to Slack via Socket Mode WebSocket |
| **When** | AFK coding — review PRs from your phone, check build status from the couch, pair with Claude from any device with Slack |
| **Why** | Only Slack channel for Claude Code. No public URL needed. Five security layers. Matches official plugin patterns exactly. |

### Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | Bun / Node.js / Docker | Flexible execution — pick your preference |
| Protocol | MCP (stdio) | Standard Claude Code channel transport |
| Connection | @slack/socket-mode v2 | Outbound WebSocket to Slack — no public URL |
| API | @slack/web-api v7 | Send messages, upload files, add reactions |
| Security | Custom gate + allowlist | 5-layer defense: inbound gate, outbound gate, exfiltration guard, prompt hardening, token security |

### Key Differentiators
1. **First Slack channel for Claude Code** — nobody else has built this, including Anthropic
2. **No public URL** — Socket Mode means outbound-only WebSocket, works behind firewalls and NAT
3. **Defense-in-depth security** — 5 layers: inbound gate, outbound gate, file exfiltration guard, prompt injection hardening, token lockdown
4. **Three runtime options** — Bun (fastest), Node.js/npx (universal), Docker (isolated)
5. **Upstream-ready** — matches `anthropics/claude-plugins-official` patterns exactly (Apache-2.0, same file structure, same conventions as Discord/Telegram)

---

## Operator-Grade System Analysis

### Executive Summary

claude-code-slack-channel is a fully built, single-file MCP server that bridges Slack workspaces to Claude Code sessions. The entire implementation lives in `server.ts` (844 lines) with two skill files for configuration and access management. It uses three dependencies (`@modelcontextprotocol/sdk`, `@slack/web-api`, `@slack/socket-mode`) — no frameworks, no middleware, no build step for Bun.

The security architecture is the most substantial part of the design. Every inbound message passes through a gate function that checks sender identity against an allowlist before anything reaches the MCP notification layer. Outbound messages are similarly gated. State files (tokens, access config) are locked to 0o600 permissions with atomic writes. The system prompt explicitly warns Claude about prompt injection patterns.

This is v0.1.0 — feature-complete for the core use case (DM chat + channel monitoring) but pre-release. No test suite yet. No CI pipeline. The immediate next step is real-world testing against a Slack workspace, then PR to `anthropics/claude-plugins-official`.

### Technology Stack

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| Runtime | Bun | 1.x | Primary execution runtime (also supports Node.js via tsx) |
| Protocol | @modelcontextprotocol/sdk | 1.27.x | MCP server + stdio transport |
| Connection | @slack/socket-mode | 2.0.x | Outbound WebSocket to Slack (no public URL) |
| API | @slack/web-api | 7.15.x | Slack REST API (messages, files, reactions) |
| Language | TypeScript | 5.9.x | Strict mode, type-checked |
| Container | Docker (oven/bun:1-slim) | — | Optional isolated runtime |

### Architecture

```
┌────────────────────────────┐
│     Slack Workspace        │
│   (cloud, api.slack.com)   │
└────────────┬───────────────┘
             │ WebSocket (Socket Mode)
             │ outbound from local machine
┌────────────▼───────────────┐
│       server.ts            │
│                            │
│  ┌──────────────────────┐  │
│  │  Socket Mode Client  │  │  ← receives events
│  └──────────┬───────────┘  │
│             │              │
│  ┌──────────▼───────────┐  │
│  │     gate()           │  │  ← drops ungated messages
│  │  (inbound security)  │  │
│  └──────────┬───────────┘  │
│             │ deliver      │
│  ┌──────────▼───────────┐  │
│  │   MCP Notification   │──┼──→ Claude Code session (stdio)
│  └──────────────────────┘  │
│                            │
│  ┌──────────────────────┐  │
│  │   Tools (reply, etc) │←─┼── Claude calls tools
│  │  + outbound gate     │  │
│  │  + assertSendable()  │  │
│  └──────────┬───────────┘  │
│             │              │
│  ┌──────────▼───────────┐  │
│  │   Web API Client     │  │  ← sends messages back
│  └──────────┬───────────┘  │
└─────────────┼──────────────┘
              │ HTTPS
┌─────────────▼──────────────┐
│     Slack Workspace        │
└────────────────────────────┘
```

### Key Tradeoffs

| Decision | Chosen | Over | Why | Revisit When |
|----------|--------|------|-----|--------------|
| Connection | Socket Mode | Webhooks | No public URL needed, works behind NAT/firewalls | Never — this is a hard requirement for local-only |
| Framework | Raw SDK | @slack/bolt | Fewer deps, smaller surface, direct event control | If event routing gets complex (10+ event types) |
| State | JSON file | SQLite/DB | Zero deps, simple read/write, atomic via rename | If access lists exceed ~1000 entries |
| Architecture | Single file | Multi-module | Matches official plugins pattern, easy to review | If server exceeds ~1500 lines |
| Auth | Dual token (bot + app) | OAuth flow | Socket Mode requires app-level token; simplest setup | If distributing as installable Slack app |

Socket Mode over webhooks is the defining choice. It means the server is local-only — no DNS, no TLS cert, no port forwarding. The tradeoff is that Socket Mode requires an app-level token with `connections:write`, which is an extra setup step. Worth it for the security posture.

### Directory Structure

```
claude-code-slack-channel/
├── .claude-plugin/
│   └── manifest.json      # Plugin metadata (name, version, description)
├── skills/
│   ├── configure.md       # /slack:configure — token setup
│   └── access.md          # /slack:access — pairing, allowlist, channels
├── server.ts              # MCP server — all logic (844 lines)
├── package.json           # 3 runtime deps, 2 dev deps
├── .mcp.json              # MCP server registration (bun server.ts)
├── Dockerfile             # Optional Docker runtime
├── tsconfig.json          # TypeScript strict config
├── ACCESS.md              # Access control schema docs
├── README.md              # Setup guide + security overview
├── CONTRIBUTING.md        # Contribution guidelines
├── SECURITY.md            # Vulnerability reporting
├── CHANGELOG.md           # Keep a Changelog format
├── CODE_OF_CONDUCT.md     # Contributor Covenant 2.1
└── LICENSE                # Apache-2.0
```

### Deployment & Operations

| Capability | Command | Notes |
|------------|---------|-------|
| Install deps | `bun install` | Or `npm install` for Node.js |
| Typecheck | `bun run typecheck` | `tsc --noEmit` — strict mode |
| Run (Bun) | `bun server.ts` | Primary runtime |
| Run (Node) | `npx tsx server.ts` | Fallback runtime |
| Run (Docker) | `docker build -t claude-slack-channel . && docker run --rm -i -v ~/.claude/channels/slack:/state claude-slack-channel` | Isolated runtime |
| Launch channel | `claude --channels plugin:slack@claude-plugins-official` | Production |
| Dev mode | `claude --dangerously-load-development-channels server:slack` | Bypasses plugin allowlist |
| Configure | `/slack:configure xoxb-... xapp-...` | Writes tokens to ~/.claude/channels/slack/.env |
| Pair user | `/slack:access pair <code>` | Approves pending pairing code |

### Current State Assessment

#### What's Working
- Full MCP server implementation with `claude/channel` capability (844 lines, type-checked)
- 5 tools: reply (with chunking), react, edit_message, fetch_messages, download_attachment
- Complete security architecture: inbound gate, outbound gate, file exfiltration guard, prompt hardening, token security
- Pairing flow with 6-char codes, 1-hour expiry, max 3 pending, max 2 replies
- Channel opt-in with mention requirement and per-channel allowlists
- Static mode for restricted deployments
- Three runtime options (Bun, Node.js, Docker)
- Clean typecheck (`tsc --noEmit` passes)

#### Areas Needing Attention
- **High** — No test suite. Core security functions (gate, assertSendable, assertOutboundAllowed) need unit tests before upstream PR.
- **High** — No CI pipeline. Need GitHub Actions for typecheck + lint at minimum.
- **Medium** — Not yet tested against a real Slack workspace. Socket Mode connection, event flow, and file upload need live verification.
- **Low** — No lint/format config (biome or eslint). Should add before upstream PR.

### Quick Reference

- **Repo:** https://github.com/jeremylongshore/claude-code-slack-channel
- **CI:** Not configured
- **License:** Apache-2.0
- **Last Release:** v0.1.0 (2026-03-20)
- **Test Coverage:** None yet
