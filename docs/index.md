# claude-code-slack-channel v0.3.1

Two-way Slack channel for the Claude Code — chat from Slack DMs and channels, approve tool calls from your phone.

A `claude/channel` implementation for Slack. Uses Socket Mode (outbound WebSocket, no public URL) to bridge Slack messages into a running Claude Code session via MCP stdio. Permission relay with Block Kit buttons lets you approve or deny Claude Code tool calls remotely. Seven defense layers prevent prompt injection, token exfiltration, and unauthorized access. Three runtime options: Bun, Node.js, Docker.

[![CI](https://github.com/jeremylongshore/claude-code-slack-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremylongshore/claude-code-slack-channel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/jeremylongshore/claude-code-slack-channel/blob/main/LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jeremylongshore/claude-code-slack-channel/badge)](https://scorecard.dev/viewer/?uri=github.com/jeremylongshore/claude-code-slack-channel)

**Links:** [GitHub](https://github.com/jeremylongshore/claude-code-slack-channel) · [Gist One-Pager](https://gist.github.com/jeremylongshore/2bef9c630d4269d2858a666ae75fca53) · [Release Notes](https://github.com/jeremylongshore/claude-code-slack-channel/releases/tag/v0.3.1)

---

## One-Pager

### The Problem

If you're using Claude Code, you're chained to the terminal. Step away from your desk and the conversation stops — worse, Claude may be waiting for permission to run a tool, and you can't approve it from your phone. Your phone has Slack, but Slack can't talk to your Claude session.

Anthropic shipped channels for Telegram and Discord, but not yet for Slack — the tool most teams already live in. The channel protocol (`claude/channel`) is documented and ready for community implementations. Slack is the obvious next channel — and this project fills that gap, including the permission relay protocol for remote tool approvals.

### The Solution

A two-file MCP server (~1000 lines in `server.ts` for stateful wiring, ~460 lines in `lib.ts` for pure functions) that connects Slack to Claude Code bidirectionally. Inbound messages arrive via Socket Mode (Slack's outbound WebSocket — no public URL, works behind any firewall). Outbound replies go through the Slack Web API. **Permission prompts** render as Block Kit messages with Allow/Deny/Details buttons — tap your phone to approve a tool call from anywhere.

Security is defense-in-depth: inbound gate drops ungated messages before MCP, outbound gate restricts replies, file exfiltration guard blocks state directory leaks, owner-only approval ensures only the session owner can approve tool calls, and system prompt hardening tells Claude to refuse manipulation attempts from messages.

### Who / What / Where / When / Why

| Aspect | Details |
|--------|---------|
| **Who** | Developers using Claude Code who collaborate via Slack |
| **What** | MCP channel server — pushes Slack events into Claude Code sessions, replies back, relays permission prompts |
| **Where** | Runs locally (your machine), connects to Slack via Socket Mode WebSocket |
| **When** | AFK coding — approve tool calls from your phone, review PRs from the couch, pair with Claude from any device with Slack |
| **Why** | Only Slack channel for Claude Code. Permission relay with Block Kit. No public URL. Seven security layers. |

### Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | Bun / Node.js / Docker | Flexible execution — pick your preference |
| Protocol | MCP (stdio) | Standard Claude Code channel transport |
| Connection | @slack/socket-mode v2 | Outbound WebSocket to Slack — no public URL |
| API | @slack/web-api v7 | Send messages, upload files, add reactions, Block Kit interactions |
| Validation | zod v3 | Schema validation for permission relay protocol |
| Security | Custom gate + allowlist | 7-layer defense: inbound gate, outbound gate, owner-only approval, exfiltration guard, symlink resolution, mrkdwn escaping, token lockdown |

### Key Differentiators

1. **Permission relay** — Approve/deny Claude Code tool calls remotely via Slack (Block Kit buttons or text fallback)
2. **No public URL** — Socket Mode means outbound-only WebSocket, works behind firewalls and NAT
3. **Defense-in-depth security** — 7 layers hardened via community security review (v0.3.0)
4. **Three runtime options** — Bun (fastest), Node.js/npx (universal), Docker (isolated)
5. **Upstream-ready** — matches `anthropics/claude-plugins-official` patterns exactly (MIT, same structure as Discord/Telegram)

---

## Operator-Grade System Analysis

### Executive Summary

claude-code-slack-channel is a production-oriented MCP server that bridges Slack workspaces to Claude Code sessions. The implementation is split across `server.ts` (~1000 lines of stateful runtime wiring) and `lib.ts` (~460 lines of pure, testable functions). Two skill files handle configuration and access management. Four dependencies (`@modelcontextprotocol/sdk`, `@slack/web-api`, `@slack/socket-mode`, `zod`) — no frameworks, no middleware, no build step for Bun.

**v0.3.1** is a patch release with two community bug fixes: clean MCP server shutdown on client disconnect (#7 — @jinsung-kang) and deduplication of dual-fire events when a message is both a `message` and `app_mention` (#8 — @CaseyMargell). The release also lands governance scaffolding (CODEOWNERS, SECURITY.md, CONTRIBUTING.md), Gemini PR review, CodeQL, and OpenSSF Scorecard.

**v0.3.0** hardened the security model via a seven-vulnerability review from @maui-99: restrictive file sendable policy with symlink resolution, outbound gate enforcement on all reply paths, display-name sanitization against prompt injection, atomic `access.json` writes with 0o600, Slack file URL validation, and frozen-lockfile dependency pinning. The test suite grew from 52 to 86 tests in v0.3.0, then to 95 tests in v0.3.1.

### Technology Stack

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| Runtime | Bun | 1.x | Primary execution runtime (also supports Node.js via tsx) |
| Protocol | @modelcontextprotocol/sdk | 1.27.x | MCP server + stdio transport |
| Connection | @slack/socket-mode | 2.0.x | Outbound WebSocket to Slack (no public URL) |
| API | @slack/web-api | 7.15.x | Slack REST API (messages, files, reactions, interactions) |
| Validation | zod | 3.25.x | Schema validation for permission relay |
| Language | TypeScript | 5.9.x | Strict mode, type-checked |
| Container | Docker (oven/bun:1-slim) | — | Optional isolated runtime |

### Architecture

```
Slack workspace (cloud)
    ↕ WebSocket (Socket Mode — outbound only, no public URL)
server.ts + lib.ts (local MCP server, spawned by Claude Code)
    ↕ stdio (MCP transport)
Claude Code session
```

Socket Mode means **no public URL needed** — works behind firewalls, NAT, anywhere.

### Security Model

| Layer | Function | Implementation |
|-------|----------|----------------|
| Inbound Gate | Drop unauthorized messages | `gate()` checks `allowFrom` and channel opt-in |
| Outbound Gate | Restrict reply targets | `assertOutboundAllowed()` checks delivered channels |
| Owner-Only Approval | Only session owner can approve tools | Button + text paths verify `access.allowFrom` |
| File Exfiltration Guard | Block state file uploads | `assertSendable()`: allowlist roots + basename/parent denylist + symlink resolution |
| mrkdwn Escaping | Prevent Slack injection | `escMrkdwn()` neutralizes `<`, `>`, `&` and sanitizes display names |
| Slack URL Validation | Block token exfiltration via crafted URLs | `isSlackFileUrl()` validates host allowlist |
| Token Security | Protect credentials | 0o600 permissions, atomic writes, never logged |

### Quality Metrics

| Metric | Value |
|--------|-------|
| Test Coverage | 95 tests, security-critical functions |
| TypeScript | Strict mode, zero errors |
| Dependencies | 4 production deps |
| Lines of Code | ~1460 total (server.ts ~1000 + lib.ts ~460) |
| CI | GitHub Actions — typecheck, test, CodeQL, Gemini review, OpenSSF Scorecard |
| Default DM Policy | `allowlist` (restrictive) — explicit user approval required |

### Current State Assessment

**What's Working**
- Full MCP server with `claude/channel` + `claude/channel/permission` capabilities
- 7 tools: `reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`, permission approval paths
- Complete security architecture: 7 defense layers, all unit-tested
- Pairing flow with 6-char codes, 1-hour expiry, max 3 pending, max 2 replies
- Channel opt-in with optional mention requirement and per-channel allowlists
- Static mode for restricted deployments (`SLACK_ACCESS_MODE=static`)
- Three runtime options (Bun, Node.js, Docker)
- Clean typecheck, 95 passing tests
- Governance: CODEOWNERS, SECURITY.md, PR template, branch protection, Dependabot

**Roadmap**
- Dedup cache scaling improvements (tracked in #11)
- Expanded test coverage for rare edge cases
- Upstream PR to `anthropics/claude-plugins-official`

### Quick Reference

- **Repo:** [github.com/jeremylongshore/claude-code-slack-channel](https://github.com/jeremylongshore/claude-code-slack-channel)
- **CI:** Passing (GitHub Actions — typecheck, test, CodeQL, Gemini review, Scorecard)
- **License:** MIT
- **Latest Release:** [v0.3.1](https://github.com/jeremylongshore/claude-code-slack-channel/releases/tag/v0.3.1) (2026-04-15)
- **Test Coverage:** 95 tests covering security-critical functions
- **Docs:** [Anthropic Channels Reference](https://docs.anthropic.com/en/docs/claude-code/channels) · [Plugin Spec](https://docs.anthropic.com/en/docs/claude-code/plugins)

### Contributors

- [@jeremylongshore](https://github.com/jeremylongshore) — author, maintainer
- [@maui-99](https://github.com/maui-99) — security hardening review (v0.3.0, 7 vulnerabilities closed)
- [@jinsung-kang](https://github.com/jinsung-kang) — clean shutdown on client disconnect (v0.3.1, #7)
- [@CaseyMargell](https://github.com/CaseyMargell) — event deduplication fix (v0.3.1, #8)
