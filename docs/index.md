
# claude-code-slack-channel v0.10.0

Enterprise Slack-native governance substrate for Claude Code — humans, Claude Code sessions, and peer agents converse safely in shared channels.

A `claude/channel` implementation for Slack. Socket Mode (outbound WebSocket, no public URL) bridges Slack into a running Claude Code session via MCP stdio. Every tool call passes through a declarative, tier-aware policy engine; every decision lands in a hash-chained, Ed25519-signed audit journal you can verify offline. Permission relay with Block Kit buttons, per-thread session isolation, operator admin commands with cross-channel approval, peer-bot loop control, and defense-in-depth against prompt injection. Three runtime options: Bun, Node.js, Docker.

[![CI](https://github.com/jeremylongshore/claude-code-slack-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremylongshore/claude-code-slack-channel/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/jeremylongshore/claude-code-slack-channel/blob/main/LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jeremylongshore/claude-code-slack-channel/badge)](https://scorecard.dev/viewer/?uri=github.com/jeremylongshore/claude-code-slack-channel)

**Links:** [GitHub](https://github.com/jeremylongshore/claude-code-slack-channel) · [Gist One-Pager](https://gist.github.com/jeremylongshore/2bef9c630d4269d2858a666ae75fca53) · [Release Notes](https://github.com/jeremylongshore/claude-code-slack-channel/releases/tag/v0.10.0)

---

## One-Pager

### The Problem

If you're using Claude Code, you're chained to the terminal. Step away from your desk and the conversation stops — worse, Claude may be waiting for permission to run a tool, and you can't approve it from your phone. Your phone has Slack, but Slack can't talk to your Claude session.

And once you put an AI agent on a chat surface a whole team (and other bots) can reach, you've created a prompt-injection vector and a governance problem: who's allowed to drive it, which tool calls run unattended, who approves the dangerous ones, and can you prove after the fact what actually happened? Anthropic shipped channels for Telegram and Discord, but not Slack — the tool most teams already live in. This project fills that gap and treats the governance problem as a first-class concern, not an afterthought.

### The Solution

An MCP server (Bun/TypeScript, ~16 production source modules, strict mode) that connects Slack to Claude Code bidirectionally. Inbound messages arrive via Socket Mode (Slack's outbound WebSocket — no public URL, works behind any firewall). Outbound replies go through the Slack Web API. **Permission prompts** render as Block Kit messages with Allow/Deny/Details buttons — tap your phone to approve a tool call from anywhere.

Security is defense-in-depth: an inbound gate drops ungated messages before they reach Claude, an outbound gate restricts replies to delivered `(channel, thread)` pairs, a file-exfiltration guard blocks state-directory leaks, system-prompt hardening tells Claude to refuse manipulation attempts from messages, and tokens are locked down (`0o600`, atomic writes, never logged). Every tool-call decision appends to a hash-chained **Ed25519-signed** audit journal — tamper-evident *and* verifiable offline by a third party against a published public key. Destructive operator commands (`!restart`) require a server-minted HMAC nonce confirmed from a second channel, closing the EchoLeak / operator-coercion class.

### Who / What / Where / When / Why

| Aspect | Details |
|--------|---------|
| **Who** | Developers and teams running Claude Code who collaborate via Slack — including multi-agent setups (Claude + Codex + Gemini in one channel) |
| **What** | MCP channel server — pushes Slack events into Claude Code sessions, replies back, relays permission prompts, gates every tool call through policy, signs an audit journal, isolates state per thread |
| **Where** | Runs locally (your machine), connects to Slack via Socket Mode WebSocket — no public URL |
| **When** | AFK coding — approve tool calls from your phone, review from the couch, pair with Claude from any device with Slack |
| **Why** | Only Slack channel for Claude Code. Permission relay with Block Kit. No public URL. Tier-aware policy engine. Ed25519-signed, offline-verifiable audit journal. Cross-channel admin approval. Defense-in-depth against prompt injection. |

### Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | Bun / Node.js / Docker | Flexible execution — pick your preference |
| Protocol | MCP (stdio) | Standard Claude Code channel transport |
| Connection | @slack/socket-mode v2 | Outbound WebSocket to Slack — no public URL |
| API | @slack/web-api v7 | Send messages, upload files, add reactions, Block Kit interactions |
| Validation | zod v3 | Schema validation for permission relay + audit journal |
| Crypto | Node built-in Ed25519 + RFC 8785 JCS | Signed, canonically-serialized audit events — no new runtime dep |
| Security | Custom gate + allowlist + tier-aware policy engine | Defense-in-depth: inbound gate, outbound gate, exfiltration guard, system-prompt hardening, token lockdown, signed journal, admin-command HMAC nonce, peer-bot rate limiting |
| Auditability | Hash-chained + Ed25519-signed append-only journal + Slack projection | Offline-verifiable log of every gate decision, policy evaluation, and admin action — with optional real-time Slack visibility |

### Key Differentiators

1. **Permission relay** — Approve/deny Claude Code tool calls remotely via Slack (Block Kit buttons or text fallback).
2. **No public URL** — Socket Mode means outbound-only WebSocket, works behind firewalls and NAT.
3. **Ed25519-signed audit journal** — Every decision hash-chained *and* signed; verifiable offline against a published public key, with an operator key-rotation CLI.
4. **Tier-aware policy engine** — `auto_approve` / `deny` / `require_approval`, evaluated strictest-tier-first (`admin → user → workspace → default`), with NIST two-person approval quorum.
5. **Admin commands with cross-channel approval** — `!clear` / `!restart` routed through gate → policy → journal → execute; destructive verbs require an HMAC nonce confirmed from a second channel (closes EchoLeak / CVE-2025-32711 / T11).
6. **Multi-agent ready** — Opt specific peer bots into a channel via `allowBotIds`, with per-bot sliding-window rate limiting and `!mute`/`!unmute` to break runaway loops.
7. **Per-thread session isolation** — Each Slack thread gets its own state file, supervisor, and policy scope.
8. **Real-time audit projection** — Mirror audit events to Slack threads (off/compact/full) for operator visibility, without ever blocking tool execution.

---

## Operator-Grade System Analysis

### Executive Summary

claude-code-slack-channel is a production-oriented MCP server that bridges Slack workspaces to Claude Code sessions and governs every tool call in between. The implementation spans ~16 production TypeScript modules in strict mode — `server.ts` (~3,250 lines of stateful runtime wiring) and `lib.ts` (~1,894 lines of pure, testable functions) at the core, with `policy.ts` (tier-aware policy engine), `journal.ts` (hash-chained + Ed25519-signed audit log), `supervisor.ts` (per-thread session state machine), `manifest.ts` (bot-manifest protocol), and epic-scoped sibling modules for crypto/key-management, admin commands, cross-channel HITL nonces, peer-bot rate limiting, mute store, streaming replies, and the ACP adapter. Five runtime dependencies (`@modelcontextprotocol/sdk`, `@slack/web-api`, `@slack/socket-mode`, `zod`, `tsx`) — no frameworks, no middleware, no build step for Bun.

**v0.10.0** is the governance cluster. Journal v2 signs every audit event with Ed25519 over RFC 8785 JCS canonical form, carrying a policy attestation; `verifyJournal()` validates mixed v1→v2 chains offline and treats a v2→v1 rollback as a tamper signal. The audit-signing key loads at boot from a SOPS+age-encrypted file, with an operator CLI (`audit-key init` / `rotate`) for key lifecycle (90-day cadence, RFC 6962-style rotation events). Admin commands (`!clear` / `!restart`) route through the full gate → policy → journal → execute pipeline; destructive verbs require an HMAC nonce confirmed from a second channel. Peer-bot coordination gained a per-`(channel, bot_id)` sliding-window rate limit plus `!mute`/`!unmute`. Streaming replies arrive via progressive `chat.update`. Policy evaluation became tier-aware (strictest-tier-wins), and denied calls are context-stripped to defeat retry-rephrase loops.

**v0.9.x** hardened journal startup (reverse-chunk tail read, single file handle, TOCTOU close) and shipped the `/slack-channel:policy` authoring skill.

**v0.6.0–v0.8.0** wired the declarative policy engine into production: `evaluate()` runs on every tool-call permission request; multi-approver quorum with NIST two-person integrity; four enforcement EventKinds (`policy.allow` / `policy.deny` / `policy.require` / `policy.approved`); boot-time shadow-rule and broad-auto-approve linting.

**v0.5.x** landed the big-picture redesign: per-thread session isolation, the hash-chained audit journal, the policy schema with monotonicity invariant + shadow linter, the thread-scoped outbound gate, and the session supervisor.

### Technology Stack

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| Runtime | Bun | 1.x | Primary execution runtime (also runs under Node.js via tsx) |
| Protocol | @modelcontextprotocol/sdk | 1.29.x | MCP server + stdio transport |
| Connection | @slack/socket-mode | 2.0.x | Outbound WebSocket to Slack (no public URL) |
| API | @slack/web-api | 7.15.x | Slack REST API (messages, files, reactions, interactions) |
| Validation | zod | 3.25.x | Schema validation for permission relay + audit journal events |
| Loader | tsx | 4.x | TypeScript execution under Node.js |
| Crypto | Node built-in Ed25519 + RFC 8785 JCS | — | Signed, canonical audit events (no new runtime dep) |
| Language | TypeScript | 5.9.x | Strict mode, type-checked |
| Container | Docker (oven/bun) | — | Optional isolated runtime |

### Architecture

```
Slack workspace (cloud)
    ↕ WebSocket (Socket Mode — outbound only, no public URL)
server.ts (MCP runtime) + lib.ts (pure gate/guard logic)
    ├─ policy.ts        tier-aware decision engine
    ├─ journal.ts       hash-chained + Ed25519-signed audit log
    ├─ supervisor.ts    per-thread session state machine
    ├─ manifest.ts      bot-manifest protocol
    └─ crypto / admin / nonce-hitl / rate-limit / mute / stream-reply / acp-adapter
    ↕ stdio (MCP transport)
Claude Code session
```

### Security Model

A documented prompt-injection vector, built defense-in-depth:

| Layer | Function | Implementation |
|-------|----------|----------------|
| Inbound gate | Drop unauthorized messages | `gate()` checks `allowFrom`, channel opt-in, and `requireMention`; bot messages dropped by default with per-channel `allowBotIds` opt-in |
| Outbound gate | Restrict reply targets | `assertOutboundAllowed()` gates on delivered `(channel, thread_ts)` pairs |
| File-exfiltration guard | Block state-directory uploads | `assertSendable()`: allowlist roots + basename/parent denylist + state-root denylist + symlink resolution |
| System-prompt hardening | Refuse manipulation in messages | Peer-bot messages flagged as same-risk as human |
| Token security | Protect credentials | `0o600` permissions, atomic writes, never logged |
| Signed audit journal | Tamper-evident + offline-verifiable record | Hash chain + Ed25519 signature over RFC 8785 JCS; `verifyJournal()` validates the chain and rejects rollback |
| Admin-command hardening | Gate privileged operator verbs | `!clear`/`!restart` through gate → policy → journal → execute; destructive verbs require an HMAC nonce confirmed cross-channel (closes EchoLeak / T11 / CVE-2025-32711); no MCP tool name starts with `admin.`, so Claude can't self-invoke |
| Peer-bot loop control | Break runaway agent loops | Per-`(channel, bot_id)` sliding-window rate limit + `!mute`/`!unmute` |

Trust boundaries, per-primitive attack surface, and threats T1–T11 are documented in [`000-docs/THREAT-MODEL.md`](https://github.com/jeremylongshore/claude-code-slack-channel/blob/main/000-docs/THREAT-MODEL.md).

### Quality Metrics

| Metric | Value |
|--------|-------|
| Test suite | **986 tests / 6,017 assertions** (unit + property + Gherkin) |
| Coverage floor | **≥ 95%** line + function, enforced in CI |
| CI gates | 9 required (typecheck, Biome, test, coverage floor, dependency-cruiser, Gherkin lint, harness-hash verify, `bun audit`, crap-score) |
| Out-of-band | CodeQL, gitleaks, OpenSSF Scorecard, manual Stryker mutation testing |
| Complexity ceiling | CRAP / cyclomatic ≤ 30 (max observed 29) |
| Production modules | ~16 source files, 34 audit EventKinds |
| Dependencies | 5 production deps, no frameworks |
| Default DM policy | `allowlist` (restrictive) |

### Current State Assessment

**What's Working**
- Full MCP server with `claude/channel` + `claude/channel/permission` capabilities
- Per-thread session isolation — each Slack thread gets its own state file and policy scope
- Hash-chained **Ed25519-signed** audit journal with offline `verifyJournal()` and an operator key-rotation CLI
- Per-channel audit projection to Slack threads (off/compact/full), never blocking tool execution
- Tier-aware declarative policy engine with `auto_approve` / `deny` / `require_approval`, NIST two-person quorum, and context-stripped denials
- Operator admin commands (`!clear` / `!restart`) with cross-channel HMAC-nonce confirmation for destructive verbs
- Multi-agent coordination: `allowBotIds`, per-bot rate limiting, `!mute`/`!unmute`
- Streaming replies via progressive `chat.update`
- Three runtime options (Bun, Node.js, Docker)
- Full governance: CODEOWNERS, SECURITY.md, branch protection, Apache 2.0

**Roadmap**
- Stryker mutation-score floor wired as a per-PR CI gate (currently manual)
- `slack/announce_task` MCP tool for structured cross-agent task coordination
- Post-execution policy edits once MCP exposes a tool-completion signal

### Quick Reference

- **Repo:** [github.com/jeremylongshore/claude-code-slack-channel](https://github.com/jeremylongshore/claude-code-slack-channel)
- **License:** Apache 2.0
- **Latest Release:** [v0.10.0](https://github.com/jeremylongshore/claude-code-slack-channel/releases/tag/v0.10.0)
- **Tests:** 986 / 6,017 assertions, ≥95% coverage floor
- **Changelog:** [CHANGELOG.md](https://github.com/jeremylongshore/claude-code-slack-channel/blob/main/CHANGELOG.md)

### Contributors

- [@jeremylongshore](https://github.com/jeremylongshore) — author, maintainer
- [@maui-99](https://github.com/maui-99) — security hardening review (v0.3.0)
- [@jinsung-kang](https://github.com/jinsung-kang) — clean shutdown fix (v0.3.1)
- [@CaseyMargell](https://github.com/CaseyMargell) — event dedup + `allowBotIds` (v0.3.1, v0.4.0)
- [@gog5-ops](https://github.com/gog5-ops) — Node.js/tsx runtime fix (v0.5.0)
