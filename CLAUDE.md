# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Slack channel for the Claude Code — two-way chat bridge via Socket Mode + MCP stdio.

## Architecture

Six production source files (Bun/TypeScript, strict mode):

| File | LoC | Purpose |
|---|---|---|
| `server.ts` | 2552 | Stateful runtime — Slack client bootstrap, MCP server, event handlers |
| `lib.ts` | 1770 | Pure functions — `gate()`, `assertSendable()`, `assertOutboundAllowed()`, session types, audit-receipt helpers |
| `journal.ts` | 1103 | Hash-chained audit log — `JournalWriter`, `verifyJournal`, redactor (Epic 30-A) |
| `supervisor.ts` | 1008 | `SessionSupervisor` — activate / deactivate / quiesce, idle reaper, quarantine (Epic 32) |
| `policy.ts` | 605 | Declarative policy engine — `evaluate()`, `detectShadowing`, `checkMonotonicity` (Epic 29) |
| `manifest.ts` | 582 | Bot-manifest protocol — schema, publish-side validation, subset check (Epic 31) |

Four runtime dependencies: `@modelcontextprotocol/sdk`, `@slack/web-api`, `@slack/socket-mode`, `zod`. No frameworks.

```
Slack workspace → Socket Mode WebSocket → server.ts → MCP stdio → Claude Code
```

**`lib.ts`** contains all pure, testable logic. Side-effect-free — accepts dependencies as parameters. When adding logic, put pure functions here and keep `server.ts` for wiring.

**`server.ts`** handles stateful concerns: Slack client bootstrap, token loading, MCP server registration, event listeners, file I/O.

**`policy.ts`, `manifest.ts`, `journal.ts`, `supervisor.ts`** are epic-scoped modules with their own design docs (see below). 31-A.4 invariant: `server.ts` does not import `manifest.ts` directly — enforced by both `.dependency-cruiser.js` and a compile-time import-graph test in `server.test.ts`.

## Commands

### Everyday

```bash
bun install                              # Install deps
bun run typecheck                        # TypeScript strict check (tsc --noEmit)
bun test                                 # Run test suite (bun:test) — 669 tests
bun test --timeout 15000                 # Match CI's timeout
bun test --watch                         # Watch mode
bun test --test-name-pattern "gate"      # Run tests matching a pattern
bun test server.test.ts                  # Just the unit suite (skip Gherkin runner)
bun test features/runner.test.ts         # Just the Gherkin scenarios (37 tests)
bun server.ts                            # Run server directly
npx tsx server.ts                        # Node.js fallback
```

### Quality gates (mirrored from CI)

```bash
bunx @biomejs/biome check .              # Lint — curated rule set (Wall 7b)
bash scripts/coverage-floor.sh 95        # Coverage floor — 95% line + func
bunx depcruise --config .dependency-cruiser.js .   # Architecture rules (Wall 7d)
bash scripts/gherkin-lint.sh --path features/ --strict   # Wall 1 lint
bash scripts/harness-hash.sh --verify    # Tamper check for pinned artifacts
bun audit --audit-level=high --ignore=GHSA-j3q9-mxjg-w52f   # Dep CVE scan
bun scripts/crap-score.ts --threshold 85 # Cyclomatic complexity gate (Wall 5)
bash scripts/bias-count.sh /tmp/test-scan   # Test-suite bias audit (manual)
```

### Mutation testing (manual, ~45 min)

```bash
bunx stryker run                         # lib+policy+manifest+journal; see 000-docs/MUTATION_REPORT.md
```

### Dev mode (bypasses plugin allowlist)

```bash
claude --dangerously-load-development-channels server:slack
```

### CI workflows (`.github/workflows/`)

- `ci.yml` — single job `Typecheck` that runs nine gates in order: typecheck → Biome lint → test → coverage floor → depcruise → gherkin-lint → harness-hash verify → bun audit → crap-score. Required by branch protection (`strict: true`).
- `secrets-scan.yml` — gitleaks v8.30.1 against PR diff (or full history on push to main). `.gitleaksignore` carries 7 fingerprints for journal-redactor test fixtures.
- `codeql.yml` — CodeQL security scan.
- `gemini-review.yml` — automated PR review.
- `scorecard.yml` — OpenSSF Scorecard.
- `notify-marketplace.yml` — marketplace notification on release.

## Merging PRs

Main is branch-protected: `Typecheck` is a required status check and `strict: true` (each PR must be up-to-date with main before merging). You have admin rights:

```bash
gh pr merge <N> --squash --admin --delete-branch
```

When merging multiple PRs in sequence, `strict: true` will re-demand Typecheck against the new main for every later PR in the queue. Temporarily drop strict, merge, restore:

```bash
echo '{"strict":false,"contexts":["Typecheck"]}' | gh api -X PATCH repos/jeremylongshore/claude-code-slack-channel/branches/main/protection/required_status_checks --input -
# merge your PRs
echo '{"strict":true, "contexts":["Typecheck"]}' | gh api -X PATCH repos/jeremylongshore/claude-code-slack-channel/branches/main/protection/required_status_checks --input -
```

## Key Files

### Production source
- `server.ts` — MCP server runtime: bootstrap, Slack clients, tools, event handling
- `lib.ts` — pure functions: gate logic, security guards, text chunking, session types
- `policy.ts` — `PolicyRule` Zod schema, `evaluate()` decision procedure, `detectShadowing` linter, `checkMonotonicity`
- `journal.ts` — hash-chained audit log: `JournalWriter`, `verifyJournal`, `EventKind`, redactor
- `supervisor.ts` — `SessionSupervisor`: activate/deactivate/quiesce, idle reaper, quarantine tracking
- `manifest.ts` — bot-manifest protocol (Epic 31): schema, `assertPublishAllowed`, `validateManifestSubset`

### Tests & acceptance contracts
- `server.test.ts` — single-file test suite covering security-critical functions (uses `bun:test`); 669 tests, 1 405 expects. Run a subset with `bun test --test-name-pattern "<pattern>"`
- `features/*.feature` — Wall 1 acceptance contracts (engineer-owned, pinned by `.harness-hash`); five primitives: `inbound_gate`, `file_exfiltration_guard`, `outbound_reply_filter`, `policy_evaluation`, `audit_chain_verifier`
- `features/runner.ts` + `features/runner.test.ts` + `features/steps/*.ts` — hand-rolled Gherkin runner executing all 37 scenarios against the real primitives

### Config
- `biome.json` — Biome lint config (curated rule set, formatter off, `recommended: false`)
- `.dependency-cruiser.js` — architecture rules, enforces 31-A.4 manifest-isolation invariant
- `stryker.conf.mjs` — mutation-testing config; mutates `lib.ts` + `policy.ts` + `manifest.ts` + `journal.ts`
- `.harness-hash` — SHA-256 manifest pinning `.feature` files + `.dependency-cruiser.js`
- `bunfig.toml` — bun runtime config (carries `[install.security]` placeholder for future scanner)
- `tsconfig.json` — TS strict, includes all production sources + `features/**/*.ts`

### Scripts
- `scripts/coverage-floor.sh` — parses `bun test --coverage` output, enforces 95% floor
- `scripts/crap-score.ts` — TS-aware AST walker for cyclomatic complexity (Wall 5)
- `scripts/gherkin-lint.sh` — Wall 1 Gherkin style check (mirrored from `/audit-tests` skill)
- `scripts/harness-hash.sh` — tamper-detect pinned artifacts (mirrored from skill)
- `scripts/bias-count.sh` — test-bias pattern scanner (mirrored from skill with pipefail fix)

### Skills & docs
- `skills/configure/SKILL.md` — `/slack-channel:configure` token setup skill
- `skills/access/SKILL.md` — `/slack-channel:access` pairing/allowlist management skill
- `ACCESS.md` — access control schema documentation
- `CHANGELOG.md` — Keep a Changelog format; every user-visible change lands with a PR entry

## Design Docs (load-bearing contracts)

The design-in-public commitment: the doc ships before the code, and the doc is the source of truth for security-boundary decisions. Read the matching doc before touching its subsystem — a PR that contradicts a frozen doc is a revert, not a merge.

### Design (contracts — read before touching the subsystem)
- `ARCHITECTURE.md` — top-level component diagram, four-principal model.
- `000-docs/THREAT-MODEL.md` — trust boundaries, attack surface per primitive, T1–T10 threats, invariants.
- `000-docs/session-state-machine.md` — `SessionKey`, supervisor contract, lifecycle (Epic 32-A/B).
- `000-docs/policy-evaluation-flow.md` — `evaluate()` decision procedure, shadow linter, monotonicity (Epic 29-A/B).
- `000-docs/audit-journal-architecture.md` — hash-chain, redaction, verify command (Epic 30-A/B).
- `000-docs/bot-manifest-protocol.md` — manifest schema, "advertisements are not grants" invariant (Epic 31-A/B).

### Audit + quality-gate reports (snapshots — diff against on next audit)
- `000-docs/TEST_AUDIT.md` — Seven Walls scorecard, suite metrics, bias audit (produced by `/audit-tests`).
- `000-docs/QUALITY_GATES.md` — Step 5.5 gate-sweep matrix: one row per quality-gate category, current state, CI wiring.
- `000-docs/MUTATION_REPORT.md` — Stryker baselines per file. Current: `journal.ts` 87.76% / `lib.ts` 84.78% / `manifest.ts` 92.06% / `policy.ts` 78.00% / All 85.22%.
- `000-docs/AUTO_REMEDIATION_REPORT.md` — Step 8 gap analysis (no-op on this suite; rubric-driven remediation would add nothing today).

When a design doc and code disagree, the code is wrong. When an audit report and current state disagree, the code is right and the report is stale — file a bd for the refresh.

## Security Architecture (critical context)

This is a prompt injection vector. Five defense layers:

1. **Inbound gate** (`gate()`) — drops ungated messages before MCP notification. Bot messages dropped by default; per-channel `allowBotIds` opts specific peer bots in. Self-echo detection matches on `bot_id` / `bot_profile.app_id` / `user === botUserId` to cover payload variants. `PERMISSION_REPLY_RE` is checked at the gate so peer bots cannot inject permission-reply text.
2. **Outbound gate** (`assertOutboundAllowed()`) — replies only to delivered channels
3. **File exfiltration guard** (`assertSendable()`) — blocks sending state dir files (`.env`, `access.json`, `sessions/`, `audit.log`). State-dir layout and per-thread session files are specified in [`000-docs/session-state-machine.md`](000-docs/session-state-machine.md) (Epic 32-A).
4. **System prompt hardening** — instructions tell Claude to refuse pairing/access from messages. Peer-bot messages are flagged as carrying the same prompt-injection risk as human messages.
5. **Token security** — `.env` chmod 0o600, atomic writes, never logged

Any change to `gate()`, `assertSendable()`, or `assertOutboundAllowed()` is security-critical.

## Audit: projection vs. authoritative log

Two distinct surfaces, often confused:

- **Authoritative log** (Epic 30-A) — `~/.claude/channels/slack/audit.log`. Hash-chained, tamper-evident, redacted per fixed rules. Every tool-call decision (`policy.allow` / `policy.deny` / `policy.require` / `policy.approved`) is written here regardless of any Slack state. Verify with `bun server.ts --verify-audit-log <path>`. This is the record.

- **Projection** (Epic 30-B) — best-effort Slack-thread mirror of selected journal events. Controlled per-channel via `ChannelPolicy.audit` (`'off'` | `'compact'` | `'full'`). Posts receipts into the originating thread so operators can see what Claude is doing without leaving Slack. **Not** authoritative: Slack API errors, rate limits, missing messages, or lost events in the stream all mean a projected event may never appear. Operators who need ground truth read the local log.

Invariants (enforced in code; see [`000-docs/audit-journal-architecture.md`](000-docs/audit-journal-architecture.md) for the design rationale):

1. The projection may never block tool execution. A failed `chat.postMessage` is logged to stderr and swallowed.
2. The projection may never write to the authoritative log. One-way flow: journal → projection.
3. Self-echoes of projected receipts are dropped by the inbound gate's triple-check (locked in by Epic 30-B.8 tests) even when the channel has `allowBotIds` configured for multi-agent coordination.
4. `'full'` mode projects redacted `input_preview` only; anything the 30-A redactor scrubs (API keys, tokens) is scrubbed in the projection too.

When investigating an incident, start with the authoritative log. Use the projection for context on *when operators knew what*, not for what *actually happened*.

## State

All state lives in `~/.claude/channels/slack/` (files `0o600`, directories `0o700`, single-writer):
- `.env` — tokens
- `access.json` — allowlist + pairing codes (atomic writes)
- `inbox/` — downloaded attachments
- `sessions/<channel>/<thread>.json` — per-thread conversation state
- `audit.log` — hash-chained authoritative journal (Epic 30-A)

Layout spec + lifecycle state machine + supervisor contract: [`000-docs/session-state-machine.md`](000-docs/session-state-machine.md). Operator-facing docs: [`ACCESS.md`](ACCESS.md#state-directory-layout).

## Conventions

- Matches `anthropics/claude-plugins-official` patterns (file structure, naming, skills).
- Bun primary runtime; Node.js/Docker as alternatives.
- Epic / sub-epic titles read like English sentences, not code. Leaf bead titles can stay technical. `ccsc-v1b: Build the policy engine's core logic` ✓, not `29-A.Eval: evaluate() + load-time safety` ✗.
- Issues → 2–5 themed epics (A/B split + sub-epics when >5 children). Don't ship one flat epic with 10 children.
- Branch naming: `feat/<description>-bz-<bead-id>` (multiple beads: chain `-bz-<bead>` per bead, e.g. `feat/security-scanners-bz-bsz-bz-8g6`). Docs-only: `docs/<description>`. Bug fixes: `fix/<description>-bz-<bead-id>`.
- Client floor: Channels require Claude Code v2.1.80+ with `claude.ai` login (Research Preview constraint — see README).

## Issue tracking (bd) — readable-trail rule

The `/audit-tests` integrity closeout (PR #129) was filed because the prior deep pass (PR #127) skipped pieces of the skill without filing bds for them — leaving only a rationale paragraph in a doc. That's not a trail, that's a memory-leak. The rule that came out of it:

**File a bd for everything skipped, deferred, or accepted as a known gap — even when the rationale looks defensible in the moment.** The bd IS the trail. Docs rot, conversations evaporate, MCP logs age out. bds survive, have IDs, and support `bd search`.

### When to file

- A tool/script in a skill refuses to run or produces noise, and you work around it → file a bd (e.g., `ccsc-g1d` for `bias-count.sh`).
- A step in a rubric/skill is marked ⚪ N/A or skipped with a rationale → file a bd to revisit.
- An auto-remediation step is deferred because of time or dependency ordering → file a bd, wire dependencies.
- A limitation surfaces in a doc ("runner not wired", "only covers lib.ts", "proxy metric until TS tool lands") → file a bd and cite the ID in the doc.
- A code comment says "TODO" or "fix later" → file a bd, replace the comment with the ID.

### How to file

1. **Title** — one sentence in plain English, naming the outcome. `Wire a Gherkin runner to make features/*.feature scenarios executable` ✓, not `mjw: runner TODO` ✗.
2. **Description** — why the bd exists, what needs to be done, and enough context that a cold reader can act. Link the discovery site (doc, PR, commit SHA) so a future investigator can find the provenance.
3. **Acceptance criteria** — concrete, testable. `bunfig.toml configures [install.security] scanner; CI runs the scanner on install` ✓, not `scanner working` ✗.
4. **Labels** — tag related work so it can be pulled as a set (`audit-integrity`, `security`, `wall1`). Use `bd list --label <x>` to surface the set later.
5. **Dependencies** — `bd dep add <this> <blocker>` whenever a bd depends on another. `bd ready` honors blockers; `bd blocked` shows the waiting set.

### How to close

**With evidence, not with a wave.** The close `--reason` is what a future audit reads to verify the bd actually shipped:

```
bd close ccsc-xyz --reason "Shipped in PR #N (commit SHA). <what changed>. <what was verified — tests, lint, CI>."
```

If the bd was killed without shipping (wrong framing, superseded, obsolete), say so explicitly in `--reason` with the superseding bd id.

### Cross-linking in docs

When a design doc, audit report, or CLAUDE.md references a known limitation, cite the bd id inline — `ccsc-tr7`, not "a follow-up task." Treat bd ids as stable identifiers in prose. Readers can jump from the doc to `bd show <id>` and back.

The reference implementation of this pattern is `000-docs/TEST_AUDIT.md` → "Post-audit follow-up (filed bds)" — one table, every deferred item as a row with a bd id, status, and one-sentence title. Copy that shape when other docs need to project the same "here's what we didn't do and why" surface.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd backup export-git   # pushes a snapshot to origin/beads-backup for cross-machine recovery
   git push
   git status  # MUST show "up to date with origin"
   ```
   (`bd dolt push` is only for projects with a Dolt remote configured via `bd dolt remote add`; this repo uses the git-branch backup path instead.)
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
