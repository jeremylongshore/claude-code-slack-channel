# Access Control Schema

The Slack channel uses `~/.claude/channels/slack/access.json` to control who can reach your Claude Code session.

## Schema

```json
{
  "dmPolicy": "pairing | allowlist | disabled",
  "allowFrom": ["U12345678"],
  "channels": {
    "C12345678": {
      "requireMention": true,
      "allowFrom": ["U12345678"]
    }
  },
  "pending": {
    "ABC123": {
      "senderId": "U87654321",
      "chatId": "D12345678",
      "createdAt": 1711000000000,
      "expiresAt": 1711003600000,
      "replies": 1
    }
  },
  "ackReaction": "eyes",
  "textChunkLimit": 4000,
  "chunkMode": "newline"
}
```

## Fields

### `dmPolicy`
Controls how DMs from unknown users are handled.

| Value | Behavior |
|-------|----------|
| `allowlist` | Only users in `allowFrom` can DM; others are silently dropped (default in this hardened fork) |
| `pairing` | Unknown senders get a 6-character code to approve via `/slack-channel:access pair` (upstream default; opt-in only) |
| `disabled` | All DMs dropped |

> **Note — default is `allowlist`:** this fork defaults to `allowlist` instead
> of the upstream `pairing` default. The pairing flow lets any workspace
> member DM the bot, receive a pairing code, and then socially-engineer the
> operator into pasting `/slack-channel:access pair <code>`. To avoid that
> foothold, the operator must explicitly add their own Slack user ID to
> `allowFrom` before DMs will reach the bot:
>
> ```
> /slack-channel:access add U01234567
> ```
>
> Replace `U01234567` with your Slack user ID (visible from your Slack
> profile → More → Copy member ID). There is no longer a self-service
> pairing-code emission by default. To temporarily re-enable the pairing
> flow — for example, to onboard an additional trusted user — edit
> `~/.claude/channels/slack/access.json` and set `dmPolicy` to `pairing`,
> then switch it back to `allowlist` afterwards.

### `allowFrom`
Array of Slack user IDs (e.g., `U12345678`) allowed to send DMs. Managed via `/slack-channel:access add/remove`.

### `channels`
Map of channel IDs to policies. Only channels listed here are monitored.

- `requireMention`: If true, only messages that @mention the bot are delivered
- `allowFrom`: If non-empty, only these user IDs are delivered from this channel

### `pending`
Active pairing codes. Auto-pruned on every gate check.

- Max 3 pending codes at once
- Each code expires after 1 hour
- Max 2 replies per code (initial + 1 reminder)

### `ackReaction`
Emoji name (without colons) to react with when a message is delivered. Set to `""` or omit to disable.

### `textChunkLimit`
Maximum characters per outbound message. Default: 4000 (Slack's limit).

### `chunkMode`
How to split long messages: `"newline"` (paragraph-aware, default) or `"length"` (fixed character count).

## Security

- File permissions: `0o600` (owner read/write only)
- Writes are atomic (write `.tmp`, then rename)
- Corrupt files are moved aside and replaced with defaults
- In static mode (`SLACK_ACCESS_MODE=static`), the file is read once at boot and never mutated

## File attachments — sendable roots

The `reply` tool can attach files to Slack messages, but only files whose
real path (symlinks resolved) sits under an **explicit allowlist of roots**.

### Default allowlist

- `~/.claude/channels/slack/inbox/` — always allowed; re-shares previously
  downloaded attachments.

### Adding additional roots

Set `SLACK_SENDABLE_ROOTS` in `~/.claude/channels/slack/.env` to a
colon-separated list of absolute paths:

```env
SLACK_SENDABLE_ROOTS=/Users/you/projects/report-outputs:/tmp/claude-artifacts
```

- Paths must be absolute; relative entries are silently dropped.
- Symlinks are followed via `realpath` before the allowlist check, so
  symlinking a secret file into an allowed root will not bypass the guard.
- The guard also applies a **basename denylist** that rejects common secret
  filenames even inside allowlisted roots:
  `.env`, `.env.*`, `.netrc`, `.npmrc`, `.pypirc`, `*.pem`, `*.key`,
  `id_rsa` / `id_ecdsa` / `id_ed25519` / `id_dsa` (and `.pub`),
  `credentials`, `credentials.*`, `.git-credentials`.
- Any path descending through `.ssh`, `.aws`, `.gnupg`, `.config/gcloud`,
  `.config/gh`, or `.git` is rejected.
- Paths containing a `..` component are rejected.

If the reply tool tries to attach a path outside the allowlist (or on the
denylist), the upload is blocked with a generic error that names WHICH
check failed but does not echo the attempted path.
