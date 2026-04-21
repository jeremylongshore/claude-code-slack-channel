# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Baseline mutation score via Stryker; configuration in `stryker.conf.mjs`; manual-run only (not in CI); baseline documented in `000-docs/MUTATION_REPORT.md`. Score: 79.85% on `lib.ts` (725 killed, 4 timed out, 184 survived of 913 mutants). `policy.ts` and `manifest.ts` are reserved for follow-up runs (`ccsc-ao9`).
- Formal 31-A.4 architecture invariant via `dependency-cruiser` + `.dependency-cruiser.js` config; CI-enforced; the existing regex test in `server.test.ts` remains as a belt-and-suspenders guard.

## [0.7.0] - 2026-04-19

### Added

- **Per-channel `audit` field on ChannelPolicy** (#105) — operators configure audit projection behavior per channel: `'off'` (default, no Slack posts), `'compact'` (tool name + outcome only), or `'full'` (includes redacted input preview). The authoritative audit log (`~/.claude/channels/slack/audit.log`) is unaffected by this setting — it always records all events.
- **Pre-execution audit receipts projected to Slack threads** (#106) — when `audit` is `'compact'` or `'full'`, the server posts a receipt to the originating thread before tool execution. Receipt includes tool name, decision (`policy.allow`/`policy.deny`/`policy.require`/`policy.approved`), and (in full mode) a redacted input preview. Self-echoes of these receipts are dropped by the inbound gate's triple-check.
- **auditReceipts map capped at 500 entries** (#110) — memory safety guard prevents unbounded growth of the `ts → eventId` tracking map used for self-echo detection. Oldest entries evicted on overflow.

### Changed

- **Documentation**: clarified the distinction between the authoritative audit log (hash-chained, local, always-on) and the Slack projection (best-effort, per-channel opt-in). Updated CLAUDE.md and added `000-docs/audit-journal-architecture.md` section on projection semantics (#109).

### Tests

- Gate self-echo regression test for audit receipts (#108) — ensures projected receipts don't re-enter the message pipeline even when the channel has `allowBotIds` configured.
- `audit:off` produces zero Slack messages test (#107) — validates that the default `audit: 'off'` setting results in no projection posts.

## [0.6.0] - 2026-04-20

### Added

- **Declarative policy enforcement at the permission-relay boundary.** Operators author rules in `access.json.policy`; the server consults `evaluate()` on every tool-call permission request and routes to one of four outcomes: `auto_allow` (matched `auto_approve`, no human prompt), `deny` (posts reason to thread, no exec), `require_human` (quorum tracking), `default_human` (no rule, legacy Block Kit flow). See [`ACCESS.md`](ACCESS.md#policy-rules) for the schema and [`000-docs/policy-evaluation-flow.md`](000-docs/policy-evaluation-flow.md) for the decision procedure (#100).
- **Multi-approver quorum with NIST two-person integrity** (#101). `require_approval` rules accept an optional `approvers` field (1–10, default 1). Votes accumulate on the verified Slack `user_id` — the same human cannot double-satisfy quorum regardless of display name. A single deny from any allowlisted user rejects the request immediately, regardless of quorum count. Block Kit message updates show progress (`N/M approvals`). Binding rationale tracked in issue #97.
- **Four new journal EventKinds now emit at enforcement time:** `policy.allow`, `policy.deny`, `policy.require`, `policy.approved`. Declared in v0.5.0; now wired. Every enforcement decision produces a hash-chained audit record with rule id, session key, and (for `require`/`approved`) the verified approver `user_id`s.
- **`thread_ts` predicate on `MatchSpec`.** Policies scope to a specific thread within a channel. Schema landed in #96 before the evaluator wiring so operators can ship thread-scoped rules against a stable v1 shape.
- **Boot-time policy footgun linter** (`detectBroadAutoApprove`) (#101). Warns on `auto_approve` rules that lack both `tool` and `pathPrefix` — almost always a misconfiguration.
- **`--verify-audit-log` CLI subcommand** (#98). `bun server.ts --verify-audit-log <path>` runs `verifyJournal()` before any state setup (no `.env`, no tokens needed). Exit codes 0/1/2 for ok / break / unexpected. Closes a design-doc gap where [`000-docs/audit-journal-architecture.md`](000-docs/audit-journal-architecture.md) specified the CLI but only the programmatic form shipped.
- **Compile-time shape-drift guards** (#102). `lib.ts` duplicates `PolicyDecision` / `VerifyResult` shapes (`PolicyDecisionShape` / `VerifyResultShape`) to stay decoupled from `policy.ts` / `journal.ts`. Bidirectional `extends` checks in `policy.ts` and `journal.ts` break the build the moment either side drifts — already caught one real drift at review time.
- **End-to-end contract tests for the policy enforcement chain** (#103). Seven integration tests covering `auto_approve` bypass, `deny` reason surfacing, `require:2` quorum with NIST `user_id` dedup, and the `default_human` fallback when no rule matches.
- **Frozen [`000-docs/v0.6.0-release-plan.md`](000-docs/v0.6.0-release-plan.md)** (#99) — design-in-public commitment to what's in v0.6.0, what's out, and why.
- **471 tests** — up from 430 in v0.5.1 (+41 covering policy enforcement, multi-approver quorum, NIST dedup, route mapping, boot-time linter, and the full end-to-end policy chain).

### Changed

- **Policy rules now load at boot.** A malformed `access.json.policy` field is fatal at boot — policy is safety-critical, silent degradation is not offered. Missing / empty policy is NOT an error (first-install path is preserved). Hot reload intentionally deferred per [release plan §R3](000-docs/v0.6.0-release-plan.md).
- **Vote-handling DRY refactor** (#102). The Block Kit button handler and the text-reply handler now share a `processApprovalVote()` helper — the state transition (`recordApprovalVote` → `grantPolicyApproval` → `journalWrite`) lives in one place; per-resolver UX stays separate.

### Known Limitations

- `pairing.accepted` and `pairing.expired` EventKinds remain unwired (P3, [`ccsc-4an`](https://github.com/jeremylongshore/claude-code-slack-channel/issues) — tracked for v0.6.1). Current journal captures `pairing.issued` so the pairing lifecycle is reconstructible from `issued` + absence of `claim`.
- No operator CLI for rule authoring; edit `access.json.policy` directly. A `/slack-channel:policy` skill is on the v0.6.1 roadmap.
- Rules match on `tool`, `channel`, `thread_ts`, and `actor`; the `argEquals` / `pathPrefix` predicates in the schema do not yet match from `permission_request` notifications because the MCP surface carries `input_preview` (string) rather than structured tool args. Tracked as a v0.7.x evolution.

## [0.5.1] - 2026-04-19

### Added
- **SessionHandle.update() mutex-serialized state mutation** (#92) — closes the "not yet implemented" stub from v0.5.0. `update(fn)` now uses a per-handle write queue so concurrent tool calls serialize their state transitions. `saveSession` uses `await writeFile` instead of `writeFileSync` and propagates file-write failures via `Error.cause`.
- **SessionSupervisor wired into server.ts** (#93) — the supervisor from v0.5.0 is now live: `createSessionSupervisor(STATE_DIR)` at boot, `supervisor.activate()` on every inbound message (human and peer-bot), idle reaper on 60s interval via `SLACK_SESSION_IDLE_MS`, `supervisor.shutdown()` on SIGTERM/SIGINT/stdin-EOF. Quarantine tracking persists across deactivate/activate cycles.
- **Journal event emission at gate/session/pairing paths** (#94) — 10 of the 19 `EventKind` values now fire in production: `system.boot`, `system.shutdown`, `gate.inbound.deliver`, `gate.inbound.drop`, `gate.outbound.allow`, `gate.outbound.deny`, `exfil.block`, `session.activate`, `session.quiesce`, `session.deactivate`. Remaining `pairing.*` and `policy.*` events land when their trigger points exist (pairing.accepted lives in the CLI skill, not the server). Journal path: `~/.claude/channels/slack/audit.log`.
- **430 tests** — up from 370 in v0.5.0 (+60 covering the security fixes and wiring).

### Fixed
- **`assertSendable` state-root denylist (S1)** (#86) — `assertSendable` now accepts an explicit `stateRoot` parameter and rejects any path under it (via `isUnderRoot` + realpath resolution). Closes the doc-vs-code gap where CLAUDE.md claimed `.env`/`access.json`/`audit.log`/`sessions/` were blocked, but only `allowlistRoots` + basename denylists were enforced. Operators who misconfigure `SLACK_SENDABLE_ROOTS=~/.claude` no longer leak `access.json`.
- **Journal broken-flag + schema-parse ordering (S2, S3)** (#89) — `_doWrite` now checks `if (this.broken) throw this.broken` at entry, ensuring in-flight queue entries reject correctly. ZodError during `JournalEvent.parse()` no longer sets `this.broken` (schema errors are retriable); parse now runs before hash computation so a bad event never mutates state.
- **`loadSession` Zod schema validation (S4)** (#87) — `loadSession` now validates against a strict `SessionSchema` Zod schema. Corrupt/attacker-modified session files (e.g., `ownerId: 123`) throw at load time instead of passing through to the supervisor. Added `owner` alias for `ownerId` during migration.
- **Per-tool Zod input schemas for MCP handlers (S5)** (#91) — All 9 MCP tools (`reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`, `upload_file`, `list_channels`, `get_thread_replies`, `list_sessions`) now validate args via `safeParse` at switch entry. Malformed calls return structured error objects with `code: "invalid_params"` instead of runtime exceptions.
- **Supervisor quarantine state survives deactivate (S6)** (#90) — `SessionSupervisor` now tracks quarantined keys in a `Map<string, Error>`. `deactivate()` on a quarantined handle moves it to the quarantine map (not silent deletion). `activate()` on a quarantined key rejects with the original error until explicit `clearQuarantine(key)`.

### Changed
- **Known caveats section removed** — the `SessionHandle.update()` stub blocker no longer applies; supervisor is fully wired.

## [0.5.0] - 2026-04-19

### Added
- **Thread-scoped session storage** (#45, #48, #51–54). Sessions now live at `~/.claude/channels/slack/sessions/<channel>/<thread>.json` instead of one file per channel. Two parallel threads in the same Slack channel no longer share state; each has its own mutex and rolling context. Migration from the v0.4.x flat layout runs once at boot — existing conversations surface as a `default` thread without context loss. Directories are `0o700`, files remain `0o600`. See [`000-docs/session-state-machine.md`](000-docs/session-state-machine.md).
- **Node.js / tsx as alternative MCP runtime** (#65) — @gog5-ops. Fixes a Bun event-loop bug where Socket Mode `message` events stop firing once `StdioServerTransport` attaches its own `data` listener to stdin. `.mcp.json` now launches via `./node_modules/.bin/tsx server.ts` by default; `tsx` added as a runtime dependency. The test suite still runs under `bun:test` (unaffected).
- **Declarative policy engine** (#47, #57, #58) — internal; not yet wired into the request pipeline. `PolicyRule` Zod schema with three effects (`auto_approve` / `deny` / `require_approval`), `evaluate()` decision procedure following XACML first-applicable ordering, shadow-rule detection for load-time linting, and monotonicity checks to prevent hot reloads from widening auto-approve coverage over existing denies. Enforcement ships in a subsequent v0.5.x once the session supervisor is complete. See [`000-docs/policy-evaluation-flow.md`](000-docs/policy-evaluation-flow.md) and [`ACCESS.md`](ACCESS.md).
- **Session supervisor skeleton** (#60, #62, #66) — internal; not yet wired. `SessionSupervisor` actor (Armstrong-style) with `activate(key, initialOwnerId?)` and `quiesce(key)` methods, in-flight tool-call tracking via AbortControllers, and structured `session.activate` / `session.quiesce` log lines for the future journal sink. `deactivate()` / idle reaper / `update()` land in a subsequent v0.5.x. See [`000-docs/session-state-machine.md`](000-docs/session-state-machine.md).
- **Design-in-public contracts** (#38–44, #59) — `ARCHITECTURE.md` with a four-principal model (user, Claude process, peer bots, Slack platform), `000-docs/THREAT-MODEL.md` with trust boundaries and T1–T10 threats, and frozen design docs for the session state machine, policy evaluation, audit journal, and bot-manifest protocol. Every subsequent PR in these areas is reviewable against the doc; drift is a review block.
- **`.gemini/commands/gemini-review.toml`** — project-specific review prompt grounded in the threat model, gate invariants, policy purity, and supervisor mutex rules. See the [Changed] section below for the workflow fix.

### Changed
- **Gemini PR review workflow actually runs reviews now** (#61, #64). The prior config allowlisted `pull_request_read` / `add_comment_to_pending_review` / `pull_request_review_write` but never declared an `mcpServers.github` block to provide them, so Gemini ran silently with a default `"You are a helpful assistant."` prompt and posted nothing. Ported the working pattern from sibling repos: slash-command prompt (`/gemini-review`) resolves to the TOML above, `mcpServers.github` runs the official `ghcr.io/github/github-mcp-server` container, and required env (`GITHUB_TOKEN`, `ISSUE_*`, `PULL_REQUEST_NUMBER`, `REPOSITORY`) is wired. If you rebase off this repo, cherry-pick `.github/workflows/gemini-review.yml` and `.gemini/commands/gemini-review.toml`.
- **Boot-time fail-fast on unparseable `SENDABLE_ROOTS`** (#56) — misconfig surfaces at startup instead of at first outbound upload, matching the posture of `.env` token loading.

### Fixed
- **`CLAUDE.md` drift** — `lib.ts` line count (460 → ~915) and `policy.ts` description updated to reflect the merged evaluator / shadow linter / monotonicity check (Epic 29-A).

### Security
- **`gate()` permission-reply hardening** — `PERMISSION_REPLY_RE` checked at the gate so peer bots (whose `allowBotIds` opt-in landed in v0.4.0) cannot inject permission-approval text. Self-echo detection triple-checks `bot_id` / `bot_profile.app_id` / `user === botUserId` to cover Slack payload variants.

### Known caveats
- `SessionHandle.update()` remains a staged stub that rejects with a "not yet implemented" bead pointer. The next v0.5.x lands it together with the `deactivate` and policy-wiring work, at which point the supervisor is callable from `server.ts`.

## [0.4.0] - 2026-04-18

### Added
- Per-channel `allowBotIds` for opt-in cross-bot message delivery (#33) — @CaseyMargell. Default-safe: absent or empty `allowBotIds` preserves the prior "all bot messages dropped" behavior for every existing install. Self-echo detection uses a triple-check against `bot_id`, `bot_profile.app_id`, and `user === botUserId` to cover Slack payload variants (including `as_user=false` posts and multi-workspace installs). Permission-reply-shaped peer-bot messages (`y abcde`, `no xyzwq`) are dropped at the gate. Peer bots still cannot approve permission prompts — that path is gated on the top-level `allowFrom`. See [ACCESS.md](ACCESS.md) for schema and security tradeoffs.
- System prompt now warns Claude that peer-bot messages carry the same prompt-injection risk as human messages and may be coordinated by an attacker who controls the peer bot's session (#33).
- Audit log line on every delivered bot message (`[slack] bot message delivered`) — diagnostics for multi-agent flows (#33).

### Changed
- Gemini PR review workflow switched from `pull_request` to `pull_request_target` so fork PRs receive AI review (#34). Workflow is read-only by design: checks out the PR head SHA but never executes any code from it, and the run-gemini-cli action is restricted to read-only shell tools.
- `PERMISSION_REPLY_RE` moved from `server.ts` to `lib.ts` so the gate can drop permission-reply-shaped peer-bot text. No behavior change for human permission replies (#33).

### Fixed
- Docs: corrected runtime dependency count in `CONTRIBUTING.md` (was "three", actually four including `zod`) and filled the `CODE_OF_CONDUCT.md` enforcement contact placeholder with `jeremy@intentsolutions.io` (#28).

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
