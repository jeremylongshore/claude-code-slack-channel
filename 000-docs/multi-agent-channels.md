# Multi-Agent Slack Channels — Setup Recipe

Operator-facing recipe for the multi-agent experience CCSC was designed
for: a single Slack channel where humans and **multiple AI agents**
converse together, each agent driven by its own bridge process.

This doc is not a tutorial — it's a recipe. It assumes you already
have one CCSC bridge running (per the main [README](../README.md)) and
want to add a second agent to the same channel.

## The shape

```
                       Slack workspace
                       ┌──────────────────────────────────────┐
                       │  #design-review channel              │
                       │                                      │
   ┌─────────────────┐ │  Jeremy:  @Claude check the tests    │
   │ Operator (you)  │─┼─┐                                    │
   │  human in Slack │ │ │ Claude:  Tests pass 952/952        │
   └─────────────────┘ │ │ Jeremy:  @Codex same on your side? │
                       │ │ Codex:   Tests pass too            │
                       │ │ Jeremy:  @Codex what about coverage│
                       │ │ Codex:   94%                       │
                       │ │ Jeremy:  @Claude same question?    │
                       │ │ Claude:  97%                       │
                       │ └────────────────────────────────────┘
                       │                                      │
                       │ Bot identities live in Slack:        │
                       │   • U_CLAUDE_BOT                     │
                       │   • U_CODEX_BOT                      │
                       └──────────┬───────────────────────────┘
                                  │ Socket Mode (one per bridge)
              ┌───────────────────┴───────────────────┐
              ▼                                       ▼
   ┌──────────────────────┐               ┌──────────────────────┐
   │ Operator A's machine │               │ Operator B's machine │
   │                      │               │                      │
   │  CCSC bridge #1      │               │  CCSC bridge #2      │
   │   ↓ MCP stdio        │               │   ↓ MCP stdio        │
   │  Claude Code         │               │  Codex (or another   │
   │                      │               │   Claude, or Gemini) │
   └──────────────────────┘               └──────────────────────┘
```

**Slack is the substrate.** Each agent runs its own bridge, but they
all post and read through one Slack channel. The operator (the human)
sees a unified thread; each bot sees just its own MCP tool calls plus
the inbound messages its gate allows.

## What's already there in CCSC

CCSC was designed for this from the start. The four-principal model
(`ARCHITECTURE.md`) names the peer agent as a first-class participant.
The pieces that make multi-agent work are already shipped:

| Capability | Where | Default |
|---|---|---|
| Multiple bots in one channel | Each bot runs its own bridge | — |
| Bots can read each other | `ChannelPolicy.allowBotIds: ['U_OTHER_BOT']` | Off (T3 mitigation) |
| Mention-driven addressing | `ChannelPolicy.requireMention: true` | Operator-configurable |
| Self-echo filter | `gate()` triple-check (`bot_id`, `app_id`, `user`) | Always on |
| Peer-bot capability discovery | `slack/read_peer_manifests` MCP tool (Epic 31-A) | Always available |
| Bridge advertises its own manifest | `slack/publish_manifest` MCP tool (Epic 31-B) | Operator opt-in |
| Loop-prevention rate limit | `peer-bot-rate-limit.ts` (`ccsc-gyt`) | Default 10 msgs / 60s per (channel, bot) |
| Operator manual loop break | `!mute @<bot>` / `!unmute @<bot>` (`ccsc-gjm`) | Operator-issued via admin verbs |
| Hash-chained signed audit | journal v2 with Ed25519 (`ccsc-22l`) | Every gate decision + cross-agent message recorded |

The architectural invariants — "advertisements are not grants" (Miller
2006, encoded in 31-A.4), per-thread session isolation, declarative
tiered policy — all hold the moment you add a second agent.

## Recipe

### 1. Register the second bot's Slack app

Each bot needs its own Slack app + bot token + app token (Socket Mode).
Follow the same registration flow you used for the first bot:

- New app at <https://api.slack.com/apps>
- Add the same scopes used by your first CCSC bridge
- Install in your workspace; record the bot's user_id (the `U_xxx`
  string Slack assigns)
- Generate an app-level token with `connections:write`
- Bot needs to be added to every channel where you want it active

The new bot's identity is its `U_xxx`. Anywhere this recipe says
`U_PEER_BOT`, substitute your real id.

### 2. Stand up the second bridge

Two options:

**Option A — separate machines.** Operator B runs their own CCSC
bridge on their box with the second bot's tokens in their own
`~/.claude/channels/slack/.env`. Two independent bridges, two
independent Claude (or Codex / Gemini) instances. Each operator owns
their bot's behavior.

**Option B — same machine, separate state dirs.** Run two bridges as
the same UID with different `SLACK_STATE_DIR` env vars. Each bridge
gets its own `.env`, `access.json`, `audit.log`, `sessions/`. Useful
for testing locally; less useful in production (one operator owning
two agents is unusual).

Either way, **each bridge is single-writer for its own state dir**
(per `journal.ts`'s `ACTIVE_PATHS` invariant). Don't try to share state.

### 3. Configure `allowBotIds` for each bridge

Each bridge defaults to dropping peer-bot messages (T3 mitigation —
prevents bot loops from forming accidentally). To opt one bot into
another's channel view, edit each bridge's `access.json`:

**On Bridge #1 (the Claude one), `access.json`:**

```json
{
  "channels": {
    "C_DESIGN_REVIEW": {
      "requireMention": true,
      "allowFrom": ["U_JEREMY", "U_OPERATOR_B"],
      "allowBotIds": ["U_CODEX_BOT"]
    }
  }
}
```

**On Bridge #2 (the Codex one), `access.json`:**

```json
{
  "channels": {
    "C_DESIGN_REVIEW": {
      "requireMention": true,
      "allowFrom": ["U_OPERATOR_B"],
      "allowBotIds": ["U_CLAUDE_BOT"]
    }
  }
}
```

Each bridge's `allowBotIds` lists the OTHER bot's user_id. Mutual
opt-in. Without it, neither bot sees the other.

`allowFrom` here is the channel's regular allow-list — operators (and
optionally other operators on a shared workspace) who can talk to that
bot. `requireMention: true` makes each bot respond only when explicitly
mentioned — turn this on to avoid every message hitting both bots.

### 4. (Recommended) Set per-channel rate limit

The default `peerBotRateLimit` (10 msgs / 60s) is conservative.
Tighten or relax per channel:

```json
"C_DESIGN_REVIEW": {
  "requireMention": true,
  "allowFrom": ["U_JEREMY"],
  "allowBotIds": ["U_CODEX_BOT"],
  "peerBotRateLimit": { "count": 5, "windowMs": 30000 }
}
```

To opt out of rate limiting in this channel: `{ "count": 0, "windowMs": 0 }`.

### 5. (Optional) Enable admin commands for loop break

If you want to be able to type `!mute @CodexBot` when a loop forms:

```json
"C_DESIGN_REVIEW": {
  "requireMention": true,
  "allowFrom": ["U_JEREMY"],
  "allowBotIds": ["U_CODEX_BOT"],
  "adminCommands": { "allowFrom": ["U_JEREMY"] }
}
```

Only operators on the `adminCommands.allowFrom` list can issue
`!mute` / `!unmute` / `!clear` / `!restart`. `!restart` additionally
requires the HMAC nonce + cross-channel handshake (`ccsc-ofn`); the
other three run without nonce friction.

### 6. Verify the setup via audit log

Both bridges write to their own `audit.log`. After a multi-agent
exchange, each bridge's log should contain:

- `gate.inbound.deliver` events for messages from the OTHER bot
  (proving `allowBotIds` opened the channel)
- `manifest.read` events if either bot invoked
  `slack/read_peer_manifests` (Epic 31-A)
- `gate.outbound.allow` events for the bot's own replies

Use `bun server.ts --verify-audit-log ~/.claude/channels/slack/audit.log`
to confirm chain integrity. After PR #177 (`ccsc-22l`), entries are
Ed25519-signed under each operator's audit key.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Bot A doesn't see Bot B's messages | A's `allowBotIds` doesn't contain B's user_id | Add `U_PEER_BOT` to A's `ChannelPolicy.allowBotIds`. No restart needed — `access.json` is hot-reloaded on every inbound message via the bridge's `getAccess()` loader. |
| Bot reacts to its own messages | Self-echo filter mis-identified the bot. Rare. | Check that `selfBotId` / `selfAppId` from `auth.test` are populated; look for unfamiliar `bot_id` values in the journal. |
| Loop between A and B | Both bots respond to each other on every message | (a) Confirm `requireMention: true` so each bot only responds when mentioned. (b) Rate limit catches it automatically — see `gate.inbound.drop` events with `dropReason: 'rate.cross_bot_loop'`. (c) Operator can type `!mute @<bot>` for immediate manual break. |
| Permission requests routed to the wrong operator | Each bot's permission requests go to ITS OWN `allowFrom` set | This is by design. Each agent's permission set is independent. If you want a shared approver, add the same operator id to both bots' `allowFrom`. |
| Both bots reply at once and they contradict | Working as designed | The model is "conversation among agents" — coordinated work needs the operator or one of the agents to claim the task explicitly. Future capability: `slack/announce_task` (`ccsc-8fc`, deferred). |

## What you DON'T get

The multi-agent experience is composable up to a point. Past that
point, it's a different product:

- **No E2E encryption.** Slack workspace admins see plaintext. CCSC
  cannot change that. If E2E is a hard requirement, you're looking
  for an Envoy-shape (relay-not-trusted) system, not CCSC.
- **No cross-workspace federation.** Each bridge lives in one Slack
  workspace. Slack Connect / shared channels handles cross-org chat
  but CCSC doesn't add anything special there.
- **No shared model context.** Each agent has its own Claude Code (or
  Codex / Gemini) session. They don't share KV cache, tool history, or
  conversation memory. They share only what they explicitly post in
  the Slack channel. (For agents that need shared state across
  machines, see [`statecraft-protocol/envoy`](https://github.com/statecraft-protocol/envoy)
  — different problem cut.)
- **No agent runtime ownership.** CCSC stays a bridge. Each agent's
  model selection, prompt template, tool surface — that's the agent's
  own runtime. CCSC governs the Slack-side chat surface, not the
  agent execution layer.

## References

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — four-principal model
  definitions (session owner, Claude process, human approver, peer
  agent)
- [`bot-manifest-protocol.md`](bot-manifest-protocol.md) — Epic 31:
  "advertisements are not grants" invariant; `read_peer_manifests` +
  `publish_manifest` MCP tools
- [`audit-journal-architecture.md`](audit-journal-architecture.md) —
  journal v2 signed events; gate decisions per peer-bot message
- [`policy-evaluation-flow.md`](policy-evaluation-flow.md) — tiered
  policy + cross-tier shadow detection (multi-operator deployment
  shape)
- [`../ACCESS.md`](../ACCESS.md) — full `ChannelPolicy` schema +
  HMAC nonce flow for destructive admin verbs

## Bead provenance

This recipe + the underlying primitives ship as the multi-agent epic:

| Bead | What | PR |
|---|---|---|
| `ccsc-7xq` | Epic — Multi-agent Slack channels (this) | — |
| `ccsc-gyt` | Per-bot per-channel sliding-window rate limit | [#182](https://github.com/jeremylongshore/claude-code-slack-channel/pull/182) |
| `ccsc-gjm` | `!mute <@bot>` / `!unmute <@bot>` operator verbs | [#183](https://github.com/jeremylongshore/claude-code-slack-channel/pull/183) |
| `ccsc-6gw` | This doc | [#184](https://github.com/jeremylongshore/claude-code-slack-channel/pull/184) |
| `ccsc-8fc` | (deferred) `slack/announce_task` MCP tool for cross-agent task coordination | — |
