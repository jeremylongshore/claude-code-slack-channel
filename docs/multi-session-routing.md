# Multi-Session Routing (Slack)

Status: **design / in progress** · Branch: `feat/multi-session-routing` · Fork: `threecee-adsk/claude-code-slack-channel`

## Goal

Run **multiple independent Claude Code sessions** — each with its own working
directory and context — and reach each one from a **different Slack channel**,
with **per-thread overrides** ("different sessions in different channels, and in
different threads as needed").

This is the destination-routing analogue of
[`agostinopisani19/claude-code-multisession-channels`](https://github.com/agostinopisani19/claude-code-multisession-channels)
(a Telegram router that routes to a single *active* session via `/switch`).
Here, instead of one global active session, a **binding table** maps Slack
destinations to sessions and routing is automatic.

## Why a router (not N monoliths)

The upstream plugin is a single hardened `server.ts` bound to one Claude Code
process. You cannot run N copies and have each "own" a channel: Slack
**load-balances Socket Mode events across all connections of one app**, so
events would scatter unpredictably across the processes. Exactly one process
must own the socket. That process becomes the **router**; Claude sessions attach
to it as lightweight clients.

## Architecture

```
                 Slack (one app, one Socket Mode connection)
                         │  app_mention / message / DM
                         ▼
              ┌───────────────────────────┐
              │  slack-router.ts          │  standalone process (the ONLY socket owner)
              │  • Socket Mode + bot token│
              │  • gate / policy / audit  │  ← reused from lib.ts / policy.ts / journal.ts
              │  • session registry       │
              │  • binding table          │  thread → channel → default
              │  • HTTP :8801 (localhost) │
              └─────┬───────────┬─────────┘
            /message│           │/message
                    ▼           ▼
        ┌──────────────┐   ┌──────────────┐
        │ slack-session│   │ slack-session│   thin MCP channel servers,
        │ (MCP, :rand) │   │ (MCP, :rand) │   spawned by Claude Code, one per session
        └──────┬───────┘   └──────┬───────┘
               │ stdio            │ stdio
          ┌────▼────┐        ┌────▼────┐
          │ Claude A│        │ Claude B│
          │ ~/forma │        │ ~/2brain│
          └─────────┘        └─────────┘
```

| Component | File | Role |
|-----------|------|------|
| **Router** | `slack-router.ts` | Owns Socket Mode + bot token. Runs the full inbound gate (allowlist/pairing/policy) and audit journal. Holds the session registry + binding table. Resolves each inbound event to a session and forwards over localhost HTTP. Posts replies/reactions to Slack on sessions' behalf (reuses the chunking/streaming/file logic). Relays permission prompts. |
| **Session channel** | `slack-session.ts` | Thin MCP channel server spawned by Claude Code. Registers with the router (name, port, pid, declared channel claims). Exposes `reply`/`react`/`edit_message`/`download_attachment`/`fetch_messages`, proxying each to the router. Relays permission requests. Heartbeats via re-register; reaps cleanly on stdin close. |
| **Single-session mode** | `server.ts` (unchanged) | The existing monolith remains the default. Multi-session is **opt-in**. |

State directories:
- `~/.claude/channels/slack/` — unchanged: `.env` (tokens), `access.json` (allowlist/pairing). **Tokens and pairing carry over** — they are independent of which process owns the socket.
- `~/.claude/slack-router/state.json` — router-owned: session registry + bindings.

## Binding model

A **binding** maps a Slack destination to a session **name**. Resolution for an
inbound event on channel `C` with thread `T` (`thread_ts`, or the message `ts`
for a top-level message):

1. `bindings.threads["C:T"]` → session, if that session is alive
2. else `bindings.channels["C"]` → session, if alive
3. else `bindings.default` → session, if alive
4. else **unbound** — the router replies (only to a DM or an `@bot` mention, to
   avoid channel noise) with the session list and `!bind` instructions.

Bindings come from two sources (both, per the design decision):

**A. Declarative claims (startup).** A session declares channels it owns via
`SLACK_BIND` (comma-separated channel IDs or `#name`s) in its environment. Sent
in `/register`; the router records them as channel bindings. If a channel is
already bound to a *different live* session, the router keeps the existing
binding and warns in stderr (no silent steal).

**B. Runtime commands (in Slack).** Allowlisted users post commands; the router
intercepts them before forwarding. Prefix `!` (avoids Slack `/`-slash-command
app config). `@bot <command>` also accepted.

| Command | Effect |
|---------|--------|
| `!sessions` | List registered sessions, their bindings, liveness, and the default. |
| `!bind <name>` | Bind the **current** destination to `<name>`. In a thread → thread binding; in a channel root → channel binding. |
| `!unbind` | Remove the binding for the current thread (if in a thread) else the current channel. |
| `!route` | Show which session the current channel/thread resolves to (and via which rule). |
| `!default <name>` / `!switch <name>` | Set the fallback `default` session. |

## HTTP protocol (localhost only)

Session → Router:
- `POST /register` `{ name, port, pid, claims: string[] }` → `{ ok, bindings }`
- `POST /unregister` `{ name }`
- `POST /reply` `{ session, chat_id, thread_ts?, text, files?, stream? }`
- `POST /react` `{ session, chat_id, ts, emoji }`
- `POST /edit` `{ session, chat_id, ts, text }`
- `POST /fetch_messages` `{ session, chat_id, ... }`
- `POST /permission_request` `{ session, request_id, tool_name, description, input_preview }`

Router → Session:
- `POST /message` `{ content, meta }` — `meta` carries `chat_id`, `thread_ts`, `message_id`, `user`, `user_id`, `ts`, attachment fields.
- `POST /permission_verdict` `{ request_id, behavior }`

**Outbound authorization.** On `/reply` etc., the router asserts the calling
`session` is the one that resolves for `(chat_id, thread_ts)` — or that the
thread was delivered to it — before posting. A session cannot post into a
destination it isn't bound to. This preserves the upstream per-thread outbound
gate, now scoped per session.

## Security posture (unchanged guarantees)

All five upstream defenses stay in the **router**: inbound allowlist/pairing
gate, outbound destination gate (now per-session), file-exfil guard, prompt-
injection hardening, token security. The hash-chained audit journal records
every decision, now annotated with the resolved session name. The session
channel holds **no** secrets and makes **no** Slack API calls directly — it only
talks to the router over loopback.

## Liveness

Sessions re-`/register` every 10s (doubles as heartbeat → auto-reconnect if the
router restarts). The router reaps a session when its pid is dead or its last
heartbeat is >30s old; bindings to a reaped session fall through to the next
resolution rule. (Mirrors the reference's reaper.)

## Packaging / opt-in

- `.mcp.json` points at a launcher that selects mode: if `SLACK_MULTISESSION=1`
  (or a router is reachable on `ROUTER_PORT`), run `slack-session.ts`; otherwise
  run the existing `server.ts` (single-session default — zero behavior change
  for current users).
- The router is started once per machine: `bun slack-router.ts` (Phase 1,
  manual). Phase 2: the first session auto-spawns the router (detached) if none
  is reachable, then retries registration.
- `ROUTER_PORT` default **8801** (Telegram reference uses 8799; kept distinct).

## Phasing

- **Phase 1** — router/session split; per-**channel** binding via `!bind` +
  `SLACK_BIND`; `reply` (text, chunked); `!sessions`/`!route`/`!unbind`/
  `!default`; single-session mode preserved.
- **Phase 2 (done)** — outbound file attachments (`reply` `files`, exfil-guarded
  via `assertSendable`/`INBOX_DIR`/`SLACK_SENDABLE_ROOTS`); `download_attachment`
  (fetch Slack files with the bot token, `isSlackFileUrl`-validated, into
  `INBOX_DIR`); streaming replies (`stream` → progressive `chat.update` via
  `streamReply`). Per-thread binding override + permission relay landed in Phase 1.
  **Deferred:** router auto-spawn — the supervisor already guarantees the router's
  lifecycle, so a session auto-spawning it is low value and adds race risk.
- **Phase 3** — tests (extend `server.test.ts`); bump version; tracking notes.

## Operations: the supervisor

`slack-supervisor.ts` keeps everything alive (config: `~/.claude/slack-router/supervisor.json`, sample `supervisor.example.json`):

- **Router** — run as a direct detached child (a plain server; no pty needed). Liveness via pid + `/health`. Respawned if dead.
- **Sessions** — each launched inside a **tmux** window `slack-<name>` (a long-lived `claude` channel session needs a persistent pty; tmux also matches the plugin's `SLACK_TMUX_SESSION` admin path). A session is *healthy* only when its tmux window exists **and** it is registered+live in the router `/health` — that proves the whole chain (claude → slack-session MCP → registered). Respawn has a `minRespawnMs` backoff to avoid thrash.
- **Resume** — each configured session gets a stable UUID. First launch uses `--session-id <uuid>`; every respawn uses `--resume <uuid>`, so the conversation persists across crashes.
- **Subcommands** — `up` (supervise forever), `status` (one snapshot), `down` (stop router + kill session tmux windows). `--once` runs a single tick.

Verified: router spawn/health/teardown work end to end. Session (tmux) path is structurally validated; full exercise needs tmux installed + a live channel session.

### Claude-Code constraints (verified against v2.1.160)

- `--dangerously-load-development-channels` is **required every launch** for a non-official (local) channel; there is **no** user-level settings/env allowlist (only org-managed `allowedChannelPlugins`). The supervisor always passes it.
- The channels flags are hidden from `claude --help` (Research Preview), so the launch line is a configurable `launchTemplate`, defaulting to the reference repo's `claude --dangerously-load-development-channels server:slack-session`.
- Sessions register the channel as a **user MCP server** (`claude mcp add -s user slack-session -- <tsx> slack-session.ts`) and load it via `server:slack-session` — no plugin install needed on the session side. (The `plugin:` + `slack-entry.ts` path remains for the plugin-install UX.)
- `--bg` does **not** exist; background-agent is a separate subcommand. Persistent sessions = tmux.

## Open questions

- Conflict policy when two sessions both declare `SLACK_BIND` for the same
  channel — current plan: first-live-wins + stderr warning. Revisit if it bites.
- Whether `!bind` with no `<name>` should bind to the most-recently-registered
  session as a convenience. Deferred; explicit name for now.
