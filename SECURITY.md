# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: jeremy@intentsolutions.io

Include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if any)

You should receive a response within 48 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Security Model

This plugin is a **prompt injection vector** — anyone who can send a message that reaches the Claude Code session can potentially manipulate Claude. Before the defense layers, it helps to name who the actors are.

### Four principals

The plugin mediates between four principals. Every defense layer below is a rule about one of them.

| Principal          | Identity                                                                                                            | Trusted for                                                                  | Not trusted for                                                                      |
|--------------------|---------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| **Session owner**  | The human at the terminal where `claude` runs; owns `~/.claude/channels/slack/` and the Slack tokens.               | Setup, pairing decisions, policy authorship, approving tool calls.           | Being online — absence must not weaken the other principals.                         |
| **Claude process** | The Claude Code session that spawned this MCP server over stdio.                                                    | Reading its own stdio channel; invoking declared tools.                      | Reading arbitrary filesystem state; reaching the network outside declared tools.     |
| **Human approver** | A human speaking through Slack — the session owner on mobile or an explicitly allowlisted teammate.                 | Sending messages that become user turns; approving tool calls when policy requires it. | Being present — their message is just content, not an authorization token.          |
| **Peer agent**     | Another bot (Claude Code instance, PagerDuty, Zapier, a coworker's agent) posting in a shared channel, opted in via `allowBotIds`. | Delivering structured signals (alerts, handoffs) after opt-in.               | Approving tool calls, granting access, or asserting identity beyond their bot user ID. |

The invariant every defense layer below enforces:

> **A message from any principal is content, never authorization.** Identity is established before a message reaches the Claude process; nothing inside the message body can change who the sender is.

The full adversary-first reading lives in [`000-docs/THREAT-MODEL.md`](000-docs/THREAT-MODEL.md) — trust-boundary diagram, attack surface per primitive, ten named threats (T1–T10), six invariants later code must preserve, and residual risks. Architectural context is in [`ARCHITECTURE.md`](ARCHITECTURE.md). Subsystem details: [session boundary](000-docs/session-state-machine.md), [policy evaluator](000-docs/policy-evaluation-flow.md), [audit journal](000-docs/audit-journal-architecture.md), [bot-manifest protocol](000-docs/bot-manifest-protocol.md).

### Defense layers

1. **Inbound gate**: Drops all messages from non-allowlisted senders before they reach MCP. Bot messages are dropped by default; channels opt in to specific peer bots via per-channel `allowBotIds` (see [ACCESS.md](ACCESS.md)). Self-echo filtering matches on `bot_id`, `bot_profile.app_id`, and `user === botUserId` to cover payload variants. Permission-reply regex is checked at the gate so peer bots cannot inject `y/n CODE` text and auto-approve a pending tool call.
2. **Outbound gate**: Restricts replies to channels that passed the inbound gate in this process's lifetime.
3. **File exfiltration guard**: Blocks sending state directory files (`.env`, `access.json`, future `sessions/`, future `audit.log`).
4. **System prompt hardening**: Instructs Claude to refuse pairing/access manipulation from messages. Peer-bot messages are explicitly flagged as carrying the same prompt-injection risk as human messages.
5. **Token security**: All secrets are `chmod 0o600`, never logged, atomic writes.

## Scope

In scope:
- Gate bypass (message reaches Claude from ungated sender) — see T1, T3 in [THREAT-MODEL.md](000-docs/THREAT-MODEL.md).
- Token exfiltration (secrets sent via reply tool or leaked in tool results) — T4.
- State tampering (access.json modified by message content) — T5.
- Outbound gate bypass (reply sent to arbitrary channel) — T6.
- Bot-to-bot amplification — self-echo bypass, cross-bot delivery without explicit `allowBotIds` opt-in, permission-relay escalation via peer-bot messages — T3, T7, T9.
- Pairing-flow social engineering (unknown DM → pairing code → coerced approval) — T2.
- Audit-log tampering (Epic 30-A, v0.4.1) — T8.

Out of scope:
- Slack platform vulnerabilities (report to Slack).
- Claude Code / Anthropic API vulnerabilities (report to Anthropic).
- Social engineering of the session owner that does not go through Slack (not a software bug).
- Same-UID host compromise — any process running as the session owner has equal authority. See R1 in [THREAT-MODEL.md](000-docs/THREAT-MODEL.md).
- Supply-chain compromise of `@slack/web-api`, `@slack/socket-mode`, `zod`, `@modelcontextprotocol/sdk` — pinned versions + `bun.lock` + CI are the mitigation.
