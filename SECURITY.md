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

This plugin is a **prompt injection vector** — anyone who can send a message that reaches the Claude Code session can potentially manipulate Claude. The security architecture has multiple defense layers:

1. **Inbound gate**: Drops all messages from non-allowlisted senders before they reach MCP. Bot messages are dropped by default; channels opt in to specific peer bots via per-channel `allowBotIds` (see [ACCESS.md](ACCESS.md)). Self-echo filtering matches on `bot_id`, `bot_profile.app_id`, and `user === botUserId` to cover payload variants.
2. **Outbound gate**: Restricts replies to channels that passed the inbound gate
3. **File exfiltration guard**: Blocks sending state directory files (`.env`, `access.json`)
4. **System prompt hardening**: Instructs Claude to refuse pairing/access manipulation from messages. Peer-bot messages are explicitly flagged as carrying the same prompt-injection risk as human messages.
5. **Token security**: All secrets are `chmod 0o600`, never logged, atomic writes

See the threat model in the project plan for the full analysis.

## Scope

In scope:
- Gate bypass (message reaches Claude from ungated sender)
- Token exfiltration (secrets sent via reply tool or leaked in tool results)
- State tampering (access.json modified by message content)
- Outbound gate bypass (reply sent to arbitrary channel)
- Bot-to-bot amplification — including self-echo bypass, cross-bot delivery without explicit `allowBotIds` opt-in, and permission-relay escalation via peer-bot messages

Out of scope:
- Slack platform vulnerabilities (report to Slack)
- Claude Code vulnerabilities (report to Anthropic)
- Social engineering of the terminal user (not a software bug)
