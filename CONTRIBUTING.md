# Contributing

We welcome contributions to the Slack channel for Claude Code.

## Development Setup

1. **Clone the repo**
   ```bash
   git clone https://github.com/jeremylongshore/claude-code-slack-channel.git
   cd claude-code-slack-channel
   ```

2. **Install dependencies**
   ```bash
   bun install
   ```

3. **Create a Slack test app** (see [README.md](README.md#1-create-a-slack-app))

4. **Configure tokens**
   ```bash
   mkdir -p ~/.claude/channels/slack
   cat > ~/.claude/channels/slack/.env << 'EOF'
   SLACK_BOT_TOKEN=xoxb-your-test-token
   SLACK_APP_TOKEN=xapp-your-test-token
   EOF
   chmod 600 ~/.claude/channels/slack/.env
   ```

5. **Run in dev mode**
   ```bash
   claude --dangerously-load-development-channels server:slack
   ```

## Code Style

- TypeScript strict mode
- No external frameworks beyond the four declared runtime dependencies (`@modelcontextprotocol/sdk`, `@slack/web-api`, `@slack/socket-mode`, `zod`)
- Run `bun run typecheck` before submitting

## Testing

Test against a real Slack workspace (no mocks — the Slack API surface is too broad for meaningful mocks).

Verify at minimum:
- [ ] MCP server starts and connects via stdio + Socket Mode
- [ ] Bot messages are dropped at gate
- [ ] Pairing flow works end-to-end
- [ ] Allowlisted DMs are delivered as `<channel>` events
- [ ] Reply tool sends messages with `unfurl_links: false`
- [ ] `assertSendable()` blocks state directory files

## Pull Requests

- One feature or fix per PR
- Describe the security implications of any changes to `gate()`, `assertSendable()`, or `assertOutboundAllowed()`
- Update CHANGELOG.md with your changes under `[Unreleased]`
- All PRs require passing typecheck

## Security

If you discover a security vulnerability, **do not open a public issue**. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under MIT.
