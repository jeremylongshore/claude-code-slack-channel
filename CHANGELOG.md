# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-04-15

### Fixed
- MCP server now terminates cleanly on client disconnect (#7) — @jinsung-kang
- Deduplicated event delivery from `message` + `app_mention` dual-fire (#8) — @CaseyMargell

### Changed
- **Governance**: Added CODEOWNERS, PR template, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md (#10)
- **CI**: Enabled Gemini PR review, CodeQL, OpenSSF Scorecard (#9, #10)
- **CI**: Bumped actions/checkout v4→v6, codeql-action v3→v4, upload-artifact to v7 (#14, #17, #21)
- **Dependabot**: Removed npm ecosystem (bun.lockb incompatibility), kept github-actions only (#20)
- **Docs**: Updated CLAUDE.md line counts and dependency count (#22)
- **Docs**: Added contributors section to README

## [0.3.0] - 2026-04-11

### Added
- File allowlist documentation in MCP instructions — Claude now knows which paths are blocked (#5)

### Fixed
- **Security**: `assertSendable` rewritten with defense-in-depth — allowlist roots + basename denylist + parent-dir denylist + symlink resolution (#5)
- **Security**: Outbound gate enforced on `react`, `edit_message`, `fetch_messages`, `download_attachment` tools (#5)
- **Security**: Display name sanitization prevents prompt injection via Slack usernames (#5)
- **Security**: `access.json` atomic write with mode 0o600 passed directly to `writeFileSync` (#5)
- **Security**: `isSlackFileUrl()` validation prevents token exfiltration via crafted file URLs (#5)
- **Security**: Dependencies pinned to exact versions with `--frozen-lockfile` on install (#5)
- Restored `start:node` script for Node.js users (#5)

### Changed
- **BREAKING**: Default `dmPolicy` changed from `pairing` to `allowlist` — new installs must add user ID before DMs work (#6)
- **BREAKING**: `assertSendable` policy changed from permissive (allow all except state dir) to restrictive (deny all except inbox + configured `SLACK_SENDABLE_ROOTS`) (#5)

### Security
- 7 vulnerabilities closed from pre-deployment security review by @maui-99
- 34 new tests covering all security-critical functions (52 → 86 total)

## [0.2.0] - 2026-04-09

### Added
- Permission relay — approve/deny Claude Code tool calls remotely via Slack (#3)
- Block Kit interactive buttons for permission prompts (Allow/Deny/Details) (#4)
- `claude/channel/permission` capability declaration
- Text-based fallback for permission replies (`y/n + 5-char code`)
- TTL-based cleanup for pending permission requests (5-minute expiry)
- mrkdwn escaping to prevent Slack injection via tool names/descriptions
- `zod` as explicit dependency for schema validation

### Fixed
- Security: owner-only approval for permission prompts (session owner must be in `allowFrom`)
- Security: outbound gate enforced on permission relay messages
- Security: delete-after-send ordering to prevent lost verdicts if notification fails
- Anthropic spec compliance: skill namespace, install commands (#2)
- Documentation: added "the" before "Claude Code", removed first MCP claims

### Changed
- License changed from Apache-2.0 to MIT

## [0.1.0] - 2026-03-20

### Added
- MCP server with `claude/channel` capability — single-file implementation (`server.ts`)
- Socket Mode connection (no public URL required)
- Inbound gate with sender allowlist and pairing flow
- Outbound gate restricting replies to delivered channels
- File exfiltration guard (`assertSendable()`)
- Tools: `reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`
- Text chunking at 4000 chars (paragraph-aware)
- Thread support via `thread_ts`
- Attachment download with name sanitization
- Bot message filtering
- Link unfurling disabled on all outbound messages
- Static access mode (`SLACK_ACCESS_MODE=static`)
- Skills: `/slack-channel:configure`, `/slack-channel:access`
- Three runtime options: Bun, Node.js/npx, Docker
- Test suite for security-critical functions — gate, assertSendable, assertOutboundAllowed (`server.test.ts`)
- Extracted shared types and helpers to `lib.ts` for testability
- CI pipeline with Bun typecheck and test runner (GitHub Actions)
- GitHub Pages landing site
- Project one-pager and operator-grade system analysis ([gist](https://gist.github.com/jeremylongshore/2bef9c630d4269d2858a666ae75fca53))

### Fixed
- Plugin schema: renamed `manifest.json` → `plugin.json` with correct fields for upstream submission
- MCP server args: fixed `.mcp.json` to use correct `server.ts` path
- Skills directory structure: moved to `skills/{name}/SKILL.md` pattern per upstream conventions
