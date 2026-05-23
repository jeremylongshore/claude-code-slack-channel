# claude-code-slack-channel v0.9.1

Enterprise Slack-native governance substrate where humans, Claude Code sessions, and peer agents converse safely in shared channels. Every tool call passes through a declarative policy engine; every gate decision lands in a hash-chained tamper-evident audit journal — per-thread session isolation, identity-aware permission gates, five-layer prompt-injection defense.

[![CI](https://github.com/jeremylongshore/claude-code-slack-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremylongshore/claude-code-slack-channel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jeremylongshore/claude-code-slack-channel/badge)](https://scorecard.dev/viewer/?uri=github.com/jeremylongshore/claude-code-slack-channel)

**Links:** [Gist One-Pager](https://gist.github.com/jeremylongshore/2bef9c630d4269d2858a666ae75fca53) · [GitHub Pages](https://jeremylongshore.github.io/claude-code-slack-channel/) · [Release Notes](https://github.com/jeremylongshore/claude-code-slack-channel/releases/tag/v0.9.1)

> **Research Preview** — Channels require Claude Code v2.1.80+ and `claude.ai` login.

## How It Works

```
Slack workspace (cloud)
    ↕ WebSocket (Socket Mode — outbound only, no public URL)
server.ts (local MCP server, spawned by Claude Code)
    ↕ stdio (MCP transport)
Claude Code session
```

Socket Mode means **no public URL needed** — works behind firewalls, NAT, anywhere.

## Quick Start

**For AI-assisted setup**: run `/slack-channel:install` and your AI assistant will walk you through every step below. The install skill also supports `doctor` (health check), `verify` (round-trip test), `repair` (auto-fix), `manifest` (one-click Slack-app import), `reset`, `tour`, and `uninstall` modes — see [`skills/install/SKILL.md`](skills/install/SKILL.md).

### Prerequisites

Before step 1, confirm you have:

- **Bun ≥ 1.0** — install with `curl -fsSL https://bun.sh/install | bash`. Node.js / Docker fallbacks are documented in [Option B](#option-b-nodejs--npx) / [Option C](#option-c-docker) below.
- **Claude Code ≥ v2.1.80** — see https://docs.claude.com/claude-code/install for upgrade.
- **`claude.ai` login** — this is a Research Preview constraint. API-key-only auth (`ANTHROPIC_API_KEY` set with no `claude.ai` session) does NOT work for Channels. Run `claude login` to complete the browser flow.

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch
2. **Socket Mode**: Settings → Socket Mode → Enable → Generate App-Level Token (`xapp-...`) with `connections:write` scope
3. **Event Subscriptions**: Enable → Subscribe to bot events:
   - `message.im` — DMs
   - `message.channels` — public channels
   - `message.groups` — private channels
   - `app_mention` — @ mentions
4. **Bot Token Scopes** (OAuth & Permissions):
   - `chat:write` — send messages
   - `channels:history` — read public channels
   - `groups:history` — read private channels
   - `im:history` — read DMs
   - `reactions:write` — add reactions
   - `files:read` — download shared files
   - `files:write` — upload files
   - `users:read` — resolve display names
5. **Install to Workspace** → Copy Bot Token (`xoxb-...`)

### 2. Configure Tokens

```bash
/slack-channel:configure xoxb-your-bot-token xapp-your-app-token
```

### 3. Run

Pick your runtime:

<a id="option-a-bun-recommended"></a>
#### Option A: Bun (recommended)

```bash
bun install
# Current (claude-code-plugins marketplace):
claude --channels plugin:slack-channel@claude-code-plugins
# Future (after upstream approval):
# claude --channels plugin:slack-channel@claude-plugins-official
```

<a id="option-b-nodejs--npx"></a>
#### Option B: Node.js / npx

```bash
npm install
# In .mcp.json, change command to: "npx", args: ["tsx", "server.ts"]
claude --channels plugin:slack-channel@claude-code-plugins
```

<a id="option-c-docker"></a>
#### Option C: Docker

```bash
docker build -t claude-slack-channel .
# In .mcp.json, change command to: "docker", args: ["run", "--rm", "-i", "-v", "~/.claude/channels/slack:/state", "claude-slack-channel"]
claude --channels plugin:slack-channel@claude-code-plugins
```

### 3.5. Add the bot to your Slack channel

**This step is the most common silent failure.** Slack installs apps to the workspace without joining any channels. The pairing DM in step 4 works because DMs auto-route, but a channel test message in step 5 will hit silence — the bot literally isn't in the channel to see the event.

1. Open Slack → navigate to the channel where you want the bot to live
2. Click the channel name at the top → **Integrations** tab
3. Click **Add an App** → select your bot
4. Confirm: the bot now appears in the channel's member list

Private channels need explicit invitation. Repeat per channel if the bot needs to be in more than one.

### 4. Pair Your Account

1. DM the bot in Slack — you'll get a 6-character pairing code
2. In your terminal: `/slack-channel:access pair <code>`
3. You're connected. Chat away.

### 5. Verify it's working

In the channel where you added the bot in step 3.5, send:

```
@<bot-name> hello
```

The bot should reply within 10 seconds. If you get silence, run `/slack-channel:install doctor` for a structured diagnosis, then `/slack-channel:install repair` to auto-fix what's fixable. See [Troubleshooting](#troubleshooting) for the top failure modes.

### Troubleshooting

The five silent-failure modes that cover ~95% of fresh-install issues:

1. **Bot is not in the channel** — see step 3.5 above. Channel test messages hit silence because the bot can't see the event.
2. **Claude Code version too old** — run `claude --version`; need ≥ v2.1.80.
3. **`claude.ai` login missing** — `ANTHROPIC_API_KEY` alone is not accepted (Research Preview constraint). Run `claude login`.
4. **Bun not installed** — `bun: command not found`. Install with `curl -fsSL https://bun.sh/install | bash` or use the Node.js fallback in Option B.
5. **Wrong file permissions on `.env`** — must be `0600`. Run `chmod 0600 ~/.claude/channels/slack/.env`, or run `/slack-channel:install repair`.

Full troubleshooting matrix (10 failure modes): [`skills/install/references/troubleshooting.md`](skills/install/references/troubleshooting.md).

## Policy Engine (v0.6.0+)

Author rules in `access.json.policy` to automate permission decisions for Claude Code tool calls. Three rule effects, first-applicable ordering:

```json
{
  "policy": [
    {
      "id": "safe-reads-in-ops",
      "effect": "auto_approve",
      "match": { "tool": "Read", "channel": "C_OPS_DOCS" }
    },
    {
      "id": "no-shell",
      "effect": "deny",
      "match": { "tool": "Bash" },
      "reason": "Shell execution is not permitted."
    },
    {
      "id": "dangerous-writes",
      "effect": "require_approval",
      "match": { "tool": "Write", "channel": "C_DEPLOY" },
      "approvers": 2,
      "ttlMs": 300000
    }
  ]
}
```

- **`auto_approve`** — skip the Block Kit prompt; the tool call runs immediately and a `policy.allow` event is journaled.
- **`deny`** — the reason is posted back into the originating thread and the call is rejected. `policy.deny` is journaled.
- **`require_approval`** — route through human approver(s). `approvers: 2` requires two **distinct** Slack `user_id`s (NIST two-person integrity; the same user cannot double-satisfy quorum by clicking twice). A single deny from any allowlisted user rejects the request immediately regardless of quorum count.
- Successful approvals grant a TTL window scoped to `(rule, channel, thread)` so a chain of similar calls doesn't re-prompt.
- Parse errors in `access.json.policy` are **fatal at boot** — policy is safety-critical, silent degradation is not offered. Missing or empty `policy` is fine (first-install path).

Full schema reference: [`ACCESS.md`](ACCESS.md#policy-rules). Decision procedure: [`000-docs/policy-evaluation-flow.md`](000-docs/policy-evaluation-flow.md). Release scope and what was deliberately deferred: [`000-docs/v0.6.0-release-plan.md`](000-docs/v0.6.0-release-plan.md).

## Access Control

See [ACCESS.md](ACCESS.md) for the full schema.

```bash
/slack-channel:access policy allowlist       # Only pre-approved users
/slack-channel:access add U12345678          # Add a user
/slack-channel:access remove U12345678       # Remove a user
/slack-channel:access channel C12345678      # Opt in a channel
/slack-channel:access channel C12345678 --mention  # Require @mention
/slack-channel:access status                 # Show current config
```

### Multi-agent coordination

Channels can opt in to cross-bot message delivery by listing trusted bot user IDs in `allowBotIds`. Useful when multiple Claude Code instances (or other bots you operate) need to coordinate in a shared channel — e.g., an ops-monitor agent and an engineering agent in `#incidents`. Default is no cross-bot delivery: every bot message is dropped at the gate. See [ACCESS.md](ACCESS.md) for the full schema and security tradeoffs.

Example `access.json` entry:

```json
{
  "channels": {
    "C_INCIDENTS": {
      "requireMention": false,
      "allowFrom": ["U_OPS_BOT", "U_ENG_BOT", "U_HUMAN"],
      "allowBotIds": ["U_OPS_BOT", "U_ENG_BOT"]
    }
  }
}
```

Self-echoes from this bot are always filtered regardless of `allowBotIds`. Peer bots cannot approve permission prompts — the permission relay gates on the top-level `allowFrom`, not the channel policy.

**For the full multi-agent recipe** — registering a second bot, configuring `allowBotIds` mutually, mention-driven addressing, loop-prevention rate limit, `!mute`/`!unmute` operator verbs, common failure modes, what you DON'T get — see [`000-docs/multi-agent-channels.md`](000-docs/multi-agent-channels.md).

## Security

- **Sender gating**: Every inbound message hits a gate. Ungated messages are silently dropped before reaching Claude.
- **Outbound gate**: Replies only work to channels that passed the inbound gate.
- **File exfiltration guard**: Cannot send `.env`, `access.json`, or other state files through the reply tool.
- **Prompt injection defense**: System instructions explicitly tell Claude to refuse pairing/access requests from Slack messages.
- **Bot filtering**: `bot_id` messages are dropped by default. Channels that host multiple cooperating agents can opt in to specific peers via `allowBotIds`; self-echoes are always filtered via `bot_id` / `bot_profile.app_id` / `user` triple-check.
- **Link unfurling disabled**: All outbound messages set `unfurl_links: false, unfurl_media: false`.
- **Token security**: `.env` is `chmod 0o600`, never logged, never in tool results.
- **Static mode**: Set `SLACK_ACCESS_MODE=static` to freeze access at boot (no runtime mutation).

## Development

```bash
# Dev mode (bypasses plugin allowlist):
claude --dangerously-load-development-channels server:slack
```

## One-Pager & System Analysis

[Full project one-pager and operator-grade system analysis](https://gist.github.com/jeremylongshore/2bef9c630d4269d2858a666ae75fca53)

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branching, commits, PR workflow, and the quality-gate checklist. AI assistants helping with contributions should read [`AGENTS.md`](AGENTS.md) first.

## Contributors

- [@jeremylongshore](https://github.com/jeremylongshore) — author, maintainer
- [@maui-99](https://github.com/maui-99) — security hardening review (v0.3.0)
- [@jinsung-kang](https://github.com/jinsung-kang) — clean shutdown on client disconnect (v0.3.1)
- [@CaseyMargell](https://github.com/CaseyMargell) — event deduplication fix (v0.3.1), cross-bot delivery via `allowBotIds` (v0.4.0)

## License

MIT
