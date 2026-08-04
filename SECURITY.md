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

This section is structured threat-model-first: (1) the adversary and the principals, (2) the mitigations, each with its own caveat stated inline, and (3) an explicit list of what this software does **not** protect against. The honest "does not protect against" list is part of the security posture, not an afterthought.

### 1. Threat model — adversary and principals

This plugin is a **prompt injection vector** — anyone who can send a message that reaches the Claude Code session can potentially manipulate Claude. Before the defense layers, it helps to name who the actors are.

#### Four principals

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

### 2. Mitigations (each with its limit)

Six defense layers. Each line states what it stops **and** what it does not — the caveat is part of the mitigation, not a footnote.

1. **Inbound gate**: Drops all messages from non-allowlisted senders before they reach MCP. Bot messages are dropped by default; channels opt in to specific peer bots via per-channel `allowBotIds` (see [ACCESS.md](ACCESS.md)). Self-echo filtering matches on `bot_id`, `bot_profile.app_id`, and `user === botUserId` to cover payload variants. Permission-reply regex is checked at the gate so peer bots cannot inject `y/n CODE` text and auto-approve a pending tool call.
   - *Limit:* the gate authenticates the **sender's identity**, not their intent. An allowlisted human who is socially engineered can still send messages that become user turns — that case is handled by the policy engine and HITL, not by the gate.
2. **Outbound gate**: Restricts replies to channels that passed the inbound gate in this process's lifetime.
   - *Limit:* the "channels seen this lifetime" set is in-memory and resets on restart — after a restart the bot must observe an inbound message from a channel before it can reply there.
3. **File exfiltration guard**: Blocks sending state directory files (`.env`, `access.json`, future `sessions/`, future `audit.log`).
   - *Limit:* it is a **path-based** guard on known state files, not general data-loss prevention. Blocking a declared *secret value* that appears inline in a payload (not as a state file) is filed as hardening work — Epic 2 (`ccsc-z0n`), per [`000-docs/ADR-002`](000-docs/ADR-002-architecture-patterns-from-peer-runtime-audit.md).
4. **System prompt hardening**: Instructs Claude to refuse pairing/access manipulation from messages. Peer-bot messages are explicitly flagged as carrying the same prompt-injection risk as human messages.
   - *Limit:* system-prompt instructions are **defense-in-depth, not a hard boundary** — they reduce but cannot eliminate injection. The gate and the policy engine are the hard boundaries; the prompt is the soft one.
5. **Token security**: All secrets are `chmod 0o600`, never logged, atomic writes.
   - *Limit:* the Claude process reads the tokens **in-process** today, so a successful in-process compromise has the live tokens in its blast radius. Narrowing that — placeholder-swap with injection only at the outbound boundary — is Epic 2 (`ccsc-z0n`).
6. **Button-click gate**: Option-button clicks (Block Kit `block_actions` outside the `perm:` namespace) are routed by the SAME gate rules as messages — channel opt-in via `getChannelPolicy`, per-channel `allowFrom`, strict `requireMention` (a click delivers only in an already-engaged thread and can never open one, since a click cannot carry a mention), DM pairing + `dmPolicy` — via the pure `decideInteractionRoute`; drops AND deliveries are journaled (`source: 'block_actions'`), and a delivered click activates its session through the supervisor like any inbound message. Clicks are only possible on buttons **this bot itself posted** (Slack routes interactivity payloads only to the message-authoring app). Agent-authored `blocks` are enforced at reply time with a container-agnostic recursive walk: a reserved `perm:`-prefixed `action_id` ANYWHERE in the payload — an `actions` element, a `section` accessory, an `input` element, or any future block shape — is rejected before record/send, so a prompt-injected agent turn cannot dress a policy-approval vote up as an innocuous option button; the serialized blocks also pass the outbound secret-value guard. Each (message, action) relays at most one click server-side (`createConsumedClickStore`), independent of the best-effort Block Kit swap; the click's `label`/`value` are length-capped and the label is mrkdwn-escaped before it is echoed into the confirmation line. Residual risks: `THREAT-MODEL.md` R8–R10 (stale channel opt-in keeps old buttons live; empty `allowFrom` admits any member's click; click-triggered tool calls inherit the R7 thread-attribution assumption).
   - *Limit:* like the inbound gate, this authenticates the **clicker's identity**, not their intent — with an empty per-channel `allowFrom`, any member of an opted-in channel can click, a lower bar than typing on a `requireMention` channel, and a delivered click marks its thread engaged for mention-free human follow-ups. Slack also delivers `block_actions` from channels the bot has since been removed from, so a stale `access.json` opt-in keeps old buttons live until it is cleaned up. Clicks do not activate a supervisor session (a click arriving while the MCP client is down is lost, not queued). The policy engine and HITL remain the hard boundary for what a resulting agent action may do.

### 3. What this does NOT protect against

Stated plainly. These are real residual risks, not hypotheticals — see also R1 in [THREAT-MODEL.md](000-docs/THREAT-MODEL.md).

- **Slack platform vulnerabilities** — report to Slack.
- **Claude Code / Anthropic API vulnerabilities** — report to Anthropic.
- **Social engineering of the session owner that does not go through Slack** — not a software bug.
- **Same-UID host compromise** — any process running as the session owner has equal authority over the state directory and tokens. There is no in-process boundary against a same-UID attacker. See R1 in [THREAT-MODEL.md](000-docs/THREAT-MODEL.md).
- **In-process token exposure** — see mitigation 5's limit; the live tokens are in-process until Epic 2 (`ccsc-z0n`) lands.
- **Supply-chain compromise** of `@slack/web-api`, `@slack/socket-mode`, `zod`, `@modelcontextprotocol/sdk` — pinned versions + `bun.lock` + CI are the only mitigation; a compromised upstream release is out of scope.

## Reporting scope

Security reports we will act on (in scope):
- Gate bypass (message reaches Claude from ungated sender) — see T1, T3 in [THREAT-MODEL.md](000-docs/THREAT-MODEL.md).
- Token exfiltration (secrets sent via reply tool or leaked in tool results) — T4.
- State tampering (access.json modified by message content) — T5.
- Outbound gate bypass (reply sent to arbitrary channel) — T6.
- Bot-to-bot amplification — self-echo bypass, cross-bot delivery without explicit `allowBotIds` opt-in, permission-relay escalation via peer-bot messages — T3, T7, T9.
- Pairing-flow social engineering (unknown DM → pairing code → coerced approval) — T2.
- Audit-log tampering (Epic 30-A) — T8.

Out-of-scope reports are enumerated under "What this does NOT protect against" above.
