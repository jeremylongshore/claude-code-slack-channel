
# claude-code-slack-channel v0.7.0

Two-way Slack channel for Claude Code — chat from Slack DMs and channels, approve tool calls from your phone.

A `claude/channel` implementation for Slack. Socket Mode (outbound WebSocket, no public URL) bridges Slack into a running Claude Code session via MCP stdio. Permission relay with Block Kit buttons, per-thread session isolation, hash-chained tamper-evident audit journal, policy-gated MCP tools, real-time audit projection to Slack threads, and a five-layer prompt-injection defense. Three runtime options: Bun, Node.js, Docker.

[![CI](https://github.com/jeremylongshore/claude-code-slack-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremylongshore/claude-code-slack-channel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/jeremylongshore/claude-code-slack-channel/blob/main/LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jeremylongshore/claude-code-slack-channel/badge)](https://scorecard.dev/viewer/?uri=github.com/jeremylongshore/claude-code-slack-channel)

**Links:** [GitHub](https://github.com/jeremylongshore/claude-code-slack-channel) · [Gist One-Pager](https://gist.github.com/jeremylongshore/2bef9c630d4269d2858a666ae75fca53) · [Release Notes](https://github.com/jeremylongshore/claude-code-slack-channel/releases/tag/v0.7.0)

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
| **Why** | Only Slack channel for Claude Code. Permission relay with Block Kit. No public URL. Five-layer prompt-injection defense. Tamper-evident audit journal. Real-time audit projection to Slack. |

### Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | Bun / Node.js / Docker | Flexible execution — pick your preference |
| Protocol | MCP (stdio) | Standard Claude Code channel transport |
| Connection | @slack/socket-mode v2 | Outbound WebSocket to Slack — no public URL |
| API | @slack/web-api v7 | Send messages, upload files, add reactions, Block Kit interactions |
| Validation | zod v3 | Schema validation for permission relay + audit journal |
| Security | Custom gate + allowlist + policy engine | 5-layer defense: inbound gate, outbound gate, exfiltration guard, system prompt hardening, token lockdown |
| Auditability | Hash-chained append-only journal + Slack projection | Tamper-evident log of every gate decision, policy evaluation, and session transition — with optional real-time Slack visibility |

### Key Differentiators

1. **Permission relay** — Approve/deny Claude Code tool calls remotely via Slack (Block Kit buttons or text fallback)
2. **No public URL** — Socket Mode means outbound-only WebSocket, works behind firewalls and NAT
3. **Tamper-evident audit journal** — Every security-relevant event hash-chained on disk for forensics
4. **Real-time audit projection** — Mirror audit events to Slack threads (off/compact/full) for operator visibility
5. **Per-thread session isolation** — Each Slack thread gets its own state file, supervisor, and policy scope
6. **Declarative policy engine** — Auto-approve, deny, or require multi-approver quorum per tool/channel/actor
7. **Five-layer prompt-injection defense** — Hardened via community security review + frozen-lockfile dependencies
8. **Three runtime options** — Bun (fastest), Node.js/npx (universal), Docker (isolated)

---

## Operator-Grade System Analysis

### Executive Summary

claude-code-slack-channel is a production-oriented MCP server that bridges Slack workspaces to Claude Code sessions. The implementation is split across `server.ts` (~1100 lines of stateful runtime wiring) and `lib.ts` (~915 lines of pure, testable functions), with `policy.ts`, `journal.ts`, and `supervisor.ts` providing the policy engine, audit log, and session state machine. Four runtime dependencies (`@modelcontextprotocol/sdk`, `@slack/web-api`, `@slack/socket-mode`, `zod`) — no frameworks, no middleware, no build step for Bun.

**v0.7.0** adds per-channel audit projection: operators configure `audit: 'off'` | `'compact'` | `'full'` per channel. When enabled, pre-execution audit receipts appear in Slack threads showing tool name, decision, and (in full mode) redacted input preview. The authoritative hash-chained log is unchanged — projection is best-effort visibility, not the record. Memory-bounded via a 500-entry LRU on the `auditReceipts` map. Self-echo regression tests ensure projected receipts don't re-enter the gate. ~500 tests.

**v0.6.0** wired the declarative policy engine into production: `evaluate()` runs on every tool-call permission request, routing to `auto_allow` / `deny` / `require_human` / `default_human`. Multi-approver quorum with NIST two-person integrity — votes accumulate on verified `user_id`, same human cannot double-satisfy quorum. Four new journal EventKinds: `policy.allow`, `policy.deny`, `policy.require`, `policy.approved`. Boot-time linter warns on overly broad `auto_approve` rules. ~471 tests.

**v0.5.1** wires the supervisor and journal into production: `SessionSupervisor` boots at startup, `activate()` fires on every inbound message, idle reaper runs on 60s interval, and 10 of 19 journal EventKinds now emit (`gate.*`, `session.*`, `exfil.block`, `system.*`). Six security fixes from the pre-release audit. ~430 tests.

**v0.5.0** landed the big-picture redesign: per-thread session isolation, hash-chained tamper-evident audit journal, policy engine with monotonicity invariant + shadow-rule linter, thread-scoped outbound gate, and `slack/list_sessions` MCP tool.

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

### Security Model

| Layer | Function | Implementation |
|-------|----------|----------------|
| Inbound Gate | Drop unauthorized messages | `gate()` checks `allowFrom` and channel opt-in; bot messages dropped by default with per-channel `allowBotIds` opt-in |
| Outbound Gate | Restrict reply targets | `assertOutboundAllowed()` gates on `(channel, thread_ts)` delivered pairs |
| File Exfiltration Guard | Block state-directory uploads | `assertSendable()`: allowlist roots + basename/parent denylist + state-root denylist + symlink resolution |
| System Prompt Hardening | Refuse manipulation in messages | Peer-bot messages flagged as same-risk as human |
| Token Security | Protect credentials | 0o600 permissions, atomic writes, never logged |

Every security-relevant event appends to a hash-chained audit journal (`audit.log`) with per-event fsync. `verifyJournal()` validates integrity.

### Quality Metrics

| Metric | Value |
|--------|-------|
| Test Coverage | ~500 tests, security-critical functions |
| TypeScript | Strict mode, zero errors |
| Dependencies | 4 production deps |
| Lines of Code | ~2000 total |
| CI | GitHub Actions — typecheck, test, CodeQL, Gemini review, OpenSSF Scorecard |
| Default DM Policy | `allowlist` (restrictive) |

### Current State Assessment

**What's Working**
- Full MCP server with `claude/channel` + `claude/channel/permission` capabilities
- Per-thread session isolation — each Slack thread gets its own state file and policy scope
- Hash-chained tamper-evident audit journal with `verifyJournal()` integrity check
- Per-channel audit projection to Slack threads (off/compact/full)
- Declarative policy engine with `auto_approve` / `deny` / `require_approval` effects
- Multi-approver quorum with NIST two-person integrity
- Thread-scoped outbound gate and thread-scoped pairing codes
- Three runtime options (Bun, Node.js, Docker)
- Full governance: CODEOWNERS, SECURITY.md, branch protection

**Roadmap (v0.8.0+)**
- Remaining journal events: `pairing.accepted`, `pairing.expired`
- `argEquals` / `pathPrefix` predicates on policy rules
- Operator CLI for rule authoring (`/slack-channel:policy` skill)

### Quick Reference

- **Repo:** [github.com/jeremylongshore/claude-code-slack-channel](https://github.com/jeremylongshore/claude-code-slack-channel)
- **License:** MIT
- **Latest Release:** [v0.7.0](https://github.com/jeremylongshore/claude-code-slack-channel/releases/tag/v0.7.0)
- **Test Coverage:** ~500 tests

### Contributors

- [@jeremylongshore](https://github.com/jeremylongshore) — author, maintainer
- [@maui-99](https://github.com/maui-99) — security hardening review (v0.3.0)
- [@jinsung-kang](https://github.com/jinsung-kang) — clean shutdown fix (v0.3.1)
- [@CaseyMargell](https://github.com/CaseyMargell) — event dedup + `allowBotIds` (v0.3.1, v0.4.0)
- [@gog5-ops](https://github.com/gog5-ops) — Node.js/tsx runtime fix (v0.5.0)
