# claude-code-slack-channel v0.5.1

Two-way Slack channel for Claude Code — chat from Slack DMs and channels, approve tool calls from your phone.

A `claude/channel` implementation for Slack. Socket Mode (outbound WebSocket, no public URL) bridges Slack into a running Claude Code session via MCP stdio. Permission relay with Block Kit buttons, per-thread session isolation, hash-chained tamper-evident audit journal, policy-gated MCP tools, and a five-layer prompt-injection defense. Three runtime options: Bun, Node.js, Docker.

[![CI](https://github.com/jeremylongshore/claude-code-slack-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremylongshore/claude-code-slack-channel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/jeremylongshore/claude-code-slack-channel/blob/main/LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jeremylongshore/claude-code-slack-channel/badge)](https://scorecard.dev/viewer/?uri=github.com/jeremylongshore/claude-code-slack-channel)

**Links:** [GitHub](https://github.com/jeremylongshore/claude-code-slack-channel) · [Gist One-Pager](https://gist.github.com/jeremylongshore/2bef9c630d4269d2858a666ae75fca53) · [Release Notes](https://github.com/jeremylongshore/claude-code-slack-channel/releases/tag/v0.5.1)

---

## One-Pager

### The Problem

If you're using Claude Code, you're chained to the terminal. Step away from your desk and the conversation stops — worse, Claude may be waiting for permission to run a tool, and you can't approve it from your phone. Your phone has Slack, but Slack can't talk to your Claude session.

Anthropic shipped channels for Telegram and Discord, but not yet for Slack — the tool most teams already live in. The channel protocol (`claude/channel`) is documented and ready for community implementations. Slack is the obvious next channel — and this project fills that gap, including the permission relay protocol for remote tool approvals.

### The Solution

A two-file MCP server (`server.ts` ~1100 lines of stateful wiring, `lib.ts` ~915 lines of pure functions) that connects Slack to Claude Code bidirectionally. Inbound messages arrive via Socket Mode (Slack's outbound WebSocket — no public URL, works behind any firewall). Outbound replies go through the Slack Web API. **Permission prompts** render as Block Kit messages with Allow/Deny/Details buttons — tap your phone to approve a tool call from anywhere.

Security is defense-in-depth: inbound gate drops ungated messages before MCP, outbound gate restricts replies to delivered (channel, thread) pairs, file exfiltration guard blocks state-directory leaks (including sibling-path misconfigurations), system prompt hardening tells Claude to refuse manipulation attempts from messages, and tokens are locked down (0o600, atomic writes, never logged). Every security-relevant event appends to a hash-chained audit journal for tamper-evident forensics.

### Who / What / Where / When / Why

| Aspect | Details |
|--------|---------|
| **Who** | Developers using Claude Code who collaborate via Slack |
| **What** | MCP channel server — pushes Slack events into Claude Code sessions, replies back, relays permission prompts, isolates state per thread |
| **Where** | Runs locally (your machine), connects to Slack via Socket Mode WebSocket |
| **When** | AFK coding — approve tool calls from your phone, review PRs from the couch, pair with Claude from any device with Slack |
| **Why** | Only Slack channel for Claude Code. Permission relay with Block Kit. No public URL. Five-layer prompt-injection defense. Tamper-evident audit journal. |

### Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | Bun / Node.js / Docker | Flexible execution — pick your preference |
| Protocol | MCP (stdio) | Standard Claude Code channel transport |
| Connection | @slack/socket-mode v2 | Outbound WebSocket to Slack — no public URL |
| API | @slack/web-api v7 | Send messages, upload files, add reactions, Block Kit interactions |
| Validation | zod v3 | Schema validation for permission relay + audit journal |
| Security | Custom gate + allowlist + policy engine | 5-layer defense: inbound gate, outbound gate, exfiltration guard, system prompt hardening, token lockdown |
| Auditability | Hash-chained append-only journal | Tamper-evident log of every gate decision, policy evaluation, and session transition |

### Key Differentiators

1. **Permission relay** — Approve/deny Claude Code tool calls remotely via Slack (Block Kit buttons or text fallback)
2. **No public URL** — Socket Mode means outbound-only WebSocket, works behind firewalls and NAT
3. **Tamper-evident audit journal** — Every security-relevant event hash-chained on disk for forensics
4. **Per-thread session isolation** — Each Slack thread gets its own state file, supervisor, and policy scope
5. **Five-layer prompt-injection defense** — Hardened via community security review + frozen-lockfile dependencies
6. **Three runtime options** — Bun (fastest), Node.js/npx (universal), Docker (isolated)

---

## Operator-Grade System Analysis

### Executive Summary

claude-code-slack-channel is a production-oriented MCP server that bridges Slack workspaces to Claude Code sessions. The implementation is split across `server.ts` (~1100 lines of stateful runtime wiring) and `lib.ts` (~915 lines of pure, testable functions), with `policy.ts`, `journal.ts`, and `supervisor.ts` providing the policy engine, audit log, and session state machine. Four runtime dependencies (`@modelcontextprotocol/sdk`, `@slack/web-api`, `@slack/socket-mode`, `zod`) — no frameworks, no middleware, no build step for Bun.

**v0.5.1** wires the supervisor and journal into production: `SessionSupervisor` boots at startup, `activate()` fires on every inbound message, idle reaper runs on 60s interval, and 10 of 19 journal EventKinds now emit (`gate.*`, `session.*`, `exfil.block`, `system.*`). Six security fixes from the pre-release audit: state-root denylist for `assertSendable`, journal broken-flag + parse ordering, Zod schema validation in `loadSession`, per-tool Zod input schemas for MCP handlers, and quarantine tracking in the supervisor. ~430 tests.

**v0.5.0** landed the big-picture redesign: per-thread session isolation (`sessions/<channel>/<thread>.json`), hash-chained tamper-evident audit journal (`journal.ts`), policy engine with monotonicity invariant + shadow-rule linter (`policy.ts`), thread-scoped outbound gate, thread-scoped pairing key, and the `slack/list_sessions` MCP tool.

**v0.4.0** added per-channel cross-bot message delivery via `allowBotIds` (#33 — @CaseyMargell). Multi-agent coordination: channels can opt in to receiving messages from specific peer bots (e.g., ops-monitor and engineering bots in `#incidents`). Default-safe — absent or empty `allowBotIds` preserves the "all bot messages dropped" behavior. Self-echo detection uses a triple-check (`bot_id`, `bot_profile.app_id`, `user`) to cover Slack payload variants.

**v0.3.1** shipped two community bug fixes: clean MCP server shutdown on client disconnect (#7 — @jinsung-kang) and deduplication of dual-fire events (#8 — @CaseyMargell). Governance scaffolding (CODEOWNERS, SECURITY.md, CONTRIBUTING.md), Gemini PR review, CodeQL, and OpenSSF Scorecard.

**v0.3.0** hardened the security model via a seven-vulnerability review from @maui-99: restrictive file sendable policy with symlink resolution, outbound gate enforcement on all reply paths, display-name sanitization against prompt injection, atomic `access.json` writes with 0o600, Slack file URL validation, and frozen-lockfile dependency pinning.

### Technology Stack

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| Runtime | Bun | 1.x | Primary execution runtime (also supports Node.js via tsx) |
| Protocol | @modelcontextprotocol/sdk | 1.27.x | MCP server + stdio transport |
| Connection | @slack/socket-mode | 2.0.x | Outbound WebSocket to Slack (no public URL) |
| API | @slack/web-api | 7.15.x | Slack REST API (messages, files, reactions, interactions) |
| Validation | zod | 3.25.x | Schema validation for permission relay + audit journal events |
| Language | TypeScript | 5.9.x | Strict mode, type-checked |
| Container | Docker (oven/bun:1-slim) | — | Optional isolated runtime |

### Architecture

```
Slack workspace (cloud)
    ↕ WebSocket (Socket Mode — outbound only, no public URL)
server.ts + lib.ts + policy.ts + journal.ts + supervisor.ts (local MCP server)
    ↕ stdio (MCP transport)
Claude Code session
```

Socket Mode means **no public URL needed** — works behind firewalls, NAT, anywhere.

### Security Model

| Layer | Function | Implementation |
|-------|----------|----------------|
| Inbound Gate | Drop unauthorized messages | `gate()` checks `allowFrom` and channel opt-in; bot messages dropped by default with per-channel `allowBotIds` opt-in |
| Outbound Gate | Restrict reply targets | `assertOutboundAllowed()` gates on `(channel, thread_ts)` delivered pairs |
| File Exfiltration Guard | Block state-directory uploads | `assertSendable()`: allowlist roots + basename/parent denylist + state-root denylist + symlink resolution |
| System Prompt Hardening | Refuse manipulation in messages | Peer-bot messages flagged as same-risk as human |
| Token Security | Protect credentials | 0o600 permissions, atomic writes, never logged |

Every security-relevant event (gate drops, policy decisions, session transitions, pairing events) appends to a hash-chained audit journal (`audit.log`) with per-event fsync. A broken chain fails loud; `verifyJournal()` validates integrity at any time.

### Quality Metrics

| Metric | Value |
|--------|-------|
| Test Coverage | ~430 tests, security-critical functions |
| TypeScript | Strict mode, zero errors |
| Dependencies | 4 production deps |
| Lines of Code | ~2000 total (`server.ts` ~1100 + `lib.ts` ~915, plus `policy.ts` / `journal.ts` / `supervisor.ts`) |
| CI | GitHub Actions — typecheck, test, CodeQL, Gemini review, OpenSSF Scorecard |
| Default DM Policy | `allowlist` (restrictive) — explicit user approval required |

### Current State Assessment

**What's Working**
- Full MCP server with `claude/channel` + `claude/channel/permission` capabilities
- Per-thread session isolation — each Slack thread gets its own state file and policy scope
- Hash-chained tamper-evident audit journal with `verifyJournal()` integrity check
- Policy engine with monotonicity invariant + shadow-rule linter
- Thread-scoped outbound gate and thread-scoped pairing codes (6-char, 1-hour expiry)
- `slack/list_sessions` MCP tool for operator introspection
- Bot manifest scaffolding — advertisements are not grants
- Channel opt-in with optional mention requirement and per-channel peer-bot allowlists
- Static mode for restricted deployments (`SLACK_ACCESS_MODE=static`)
- Three runtime options (Bun, Node.js, Docker)
- Governance: CODEOWNERS, SECURITY.md, PR template, branch protection, Dependabot

**Roadmap (v0.6.0)**
- Remaining journal events: `pairing.accepted`, `pairing.expired`, `policy.*`
- `evaluate()` policy enforcement in MCP tool-call path
- Upstream PR to `anthropics/claude-plugins-official`

### Quick Reference

- **Repo:** [github.com/jeremylongshore/claude-code-slack-channel](https://github.com/jeremylongshore/claude-code-slack-channel)
- **CI:** Passing (GitHub Actions — typecheck, test, CodeQL, Gemini review, Scorecard)
- **License:** MIT
- **Latest Release:** [v0.5.1](https://github.com/jeremylongshore/claude-code-slack-channel/releases/tag/v0.5.1)
- **Test Coverage:** ~430 tests covering security-critical functions
- **Docs:** [Anthropic Channels Reference](https://docs.anthropic.com/en/docs/claude-code/channels) · [Plugin Spec](https://docs.anthropic.com/en/docs/claude-code/plugins)

### Contributors

- [@jeremylongshore](https://github.com/jeremylongshore) — author, maintainer
- [@maui-99](https://github.com/maui-99) — security hardening review (v0.3.0, 7 vulnerabilities closed)
- [@jinsung-kang](https://github.com/jinsung-kang) — clean shutdown on client disconnect (v0.3.1, #7)
- [@CaseyMargell](https://github.com/CaseyMargell) — event deduplication fix (v0.3.1, #8), cross-bot delivery via `allowBotIds` (v0.4.0, #33)
