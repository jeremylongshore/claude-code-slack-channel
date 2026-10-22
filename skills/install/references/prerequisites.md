# Prerequisites — detailed checks

Reference for the `install` mode's Step 0. Each check has a
deterministic detection command and a copy-pasteable recovery.

## 1. Node.js ≥ 20

```bash
command -v node
node --version
```

The version command requires normal approval because the install skill does not
preapprove Node execution. If Node is missing or older than 20, stop and ask the
operator to provision a supported Node runtime. Do not install packages or edit
`.mcp.json` to work around the missing prerequisite.

The copied plugin launches its committed `scripts/slack-channel-runtime.mjs`
through Node. It does not depend on local or ancestor `node_modules`, Bun, npx,
or an install/build lifecycle. The adjacent provenance and full license notices
identify the distribution inputs. External SOPS/tmux requirements still apply
when their existing optional audit-signing/admin features are configured.

### Source development

Maintainers use Bun with `bun install --frozen-lockfile` and `bun server.ts`.
Rebuild the distribution with `npm run build:runtime`; `npm run check:runtime`
fails on missing or stale generated files. The Dockerfile is a separate source
recipe, not a tested installed-plugin fallback in this procedure.

## 2. Claude Code with Channels support

**Detect:**

```bash
claude --version
```

Use a current Claude Code build and confirm that `claude --help` exposes the
`--channels` option. Version `2.1.80` was the original research-preview floor,
not a permanent statement of the current support boundary.

**Upgrade:**

Follow the official install / upgrade path at https://code.claude.com/docs/en/setup.
On most systems:

```bash
# macOS / Linux
curl -fsSL https://claude.ai/install.sh | bash

# Or if installed via npm
npm install -g @anthropic-ai/claude-code@latest
```

Re-check with `claude --version` after upgrading.

## 3. Supported Anthropic authentication and organization policy

**Detect:**

```bash
claude auth status
```

(If the installed build exposes a different auth-status command, trust its
current `--help` output.)

The current Channels contract accepts either a `claude.ai` account or an
Anthropic Console API key. It does not support authentication through Amazon
Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry.

For a `claude.ai` login:

```bash
claude login
```

Complete the browser flow, then confirm the authenticated session. Console API
key users should confirm that Claude Code is using their Console credential.

### Why this matters

On claude.ai Team and Enterprise plans, an Owner must enable Channels under
**Admin settings → Claude Code → Channels**, or deploy
`channelsEnabled: true` in managed settings. Console organizations permit
Channels by default unless managed settings disable them. A policy block can
look like a plugin-registration failure, so check it before rotating Slack
tokens.

## Optional: `jq` (only needed for `doctor` / `repair` modes)

The `doctor` and `repair` modes use `jq` for JSON parsing of Slack API
responses and `access.json` validation. The `install` mode itself does
not need it — skip this if you're only doing a fresh install.

```bash
command -v jq    # confirm whether jq is installed
```

If missing:

```bash
# macOS
brew install jq

# Debian / Ubuntu
sudo apt install jq

# Fedora / RHEL
sudo dnf install jq

# Other: https://jqlang.org/download/
```

## All required checks green? Proceed to Step 1

When the runtime, Channels option, authentication, and organization policy all
report acceptable values, continue to the Slack app creation step.

Authoritative source: [Claude Code Channels](https://code.claude.com/docs/en/channels).
