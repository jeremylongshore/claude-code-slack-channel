# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Skills: `/slack:configure`, `/slack:access`
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
