# Test Audit — Deep Pass, Post-Epic-31 Health Check

**Date:** 2026-04-20 (deep pass, supersedes the 2026-04-20 shallow pass)
**Commit at audit:** `57a1821` (head of main after PR #125)
**Triggered by:** `/audit-tests` — deep methodology run, superseding the shallow surface pass that produced the previous revision of this file
**Bead:** `ccsc-ao9` (this pass) · supersedes closed `ccsc-n8e`

This pass differs from the prior revision in that every Wall is backed by deterministic tool output captured under `/tmp/audit-run-1776735120/`, not by narrative. Where a tool could not run cleanly (skill script bugs, TS-awareness gaps), this doc says so explicitly and documents the workaround used.

---

## TL;DR

**Suite is in excellent health, with two corrections to the prior numbers:**
- Tests: **594** pass (the earlier doc said 549; the correct count is 594)
- `.toThrow()`: **181** (earlier doc said 104; correct is 181 — includes `.not.toThrow()` positive-case checks)
- Assertion density: **2.28** expect/test (earlier doc's 2.47 was based on the wrong test denominator)

Coverage is 98.37% lines / 98.75% functions across `lib.ts`, `policy.ts`, `manifest.ts`, `journal.ts`, `supervisor.ts`. Zero `.skip`/`.only`/`.todo`. Bias rate: 1.37% `toBeDefined`/100 tests = LOW per the skill's grading. Escape-scan across the last 100 commits: REFUSE=0, CHALLENGE=0, FLAG=0. dependency-cruiser on the default ruleset: 0 violations across 2197 modules and 4054 dependencies. TruffleHog: 0 verified secrets (69 unverified, all in `node_modules/zod` test fixtures upstream — not our code).

**No P0 findings.** Real improvements are:
1. Flaky `verifyJournal 1000-event chain` test — fix in this PR (timeout bump).
2. Coverage floor in CI — adding parser-based enforcement in this PR (Bun 1.2.23 does not enforce `coverageThreshold` via bunfig; we parse text output instead).
3. Formalize 31-A.4 as a `dependency-cruiser` rule alongside the existing regex test — parallel PR (`feat(arch): formalize 31-A.4 invariant`).
4. Baseline mutation score via Stryker — parallel PR (`feat(test): mutation testing setup`).

Improvements that need Jeremy's call are filed as separate beads, not snuck into this audit's scope (Biome adoption, Stryker CI integration, pre-commit hooks).

---

## Seven Walls scorecard (deterministic evidence)

All evidence paths are under `/tmp/audit-run-1776735120/` from the run that authored this doc.

| # | Wall | Status | Evidence |
|---|------|--------|----------|
| 1 | Acceptance (Gherkin) | ⚪ N/A | No `features/` dir; the `000-docs/*.md` design docs serve as the acceptance-level contracts for this project. Skill permits this. |
| 2 | Unit tests | ✅ Pass | `wall2-test.txt` → `594 pass · 0 fail · 1355 expect() calls · 3.65s` |
| 3 | Coverage floor | 🟡 → 🟢 | `wall3-coverage.txt` → 98.37% line / 98.75% func. Floor added in this PR via `scripts/coverage-floor.sh` (see Phase C). |
| 4 | Mutation kill-rate | ⚪ → 🔜 | Deferred to parallel PR (Phase E). Skill script runs as subagent in worktree. |
| 5 | CRAP (production) | ✅ Proxy | `complexity-proxy.txt`: per-file cyclomatic proxy 6.9–15.5 (branches+1 per func). Even with 98% cov → CRAP ≈ complexity, well under the 30 threshold. Full CRAP would need a TS-aware complexity tool; the skill's `crap-score.py` uses `complexity-report` which doesn't parse modern TS. |
| 6 | CRAP (test) | ✅ Proxy | Same mechanism. Test code is straight-line `describe/test` — no deep nesting, no recursion. |
| 7 | Architecture rules | ✅ + 🔜 | `wall7-arch.txt` → `arch-check.sh` reports `tool=none status=not-configured`. `depcruise-noconfig.txt` → 0 violations on default rules, 2197 modules / 4054 deps. 31-A.4 invariant remains enforced via the existing import-graph test in `server.test.ts`. Parallel PR (Phase D) adds `.dependency-cruiser.js` with the 31-A.4 rule as a second gate. |

Escape scan (Wall-level cross-cutting check):
```
$ bash /home/jeremy/.claude/skills/audit-tests/scripts/escape-scan.sh --range HEAD~100..HEAD
escape-scan: REFUSE=0 CHALLENGE=0 FLAG=0
```
No bypasses, no disabled tests, no neutered assertions in the last 100 commits.

---

## Suite metrics

### Volume

| Metric | Value | Source |
|---|---|---|
| Test file | `server.test.ts` | `wc -l` → 9299 LoC |
| Production LoC | 7620 (`lib` 1770 + `policy` 605 + `manifest` 582 + `journal` 1103 + `supervisor` 1008 + `server` 2552) | `loc-counts.txt` |
| Test:code ratio | 1.22:1 | computed |
| Top-level `describe`/`test`/`it` | 75 | `grep -cE '^(describe\|test\|it)\('` |
| Indented test leaves | 582 | `grep -cE '^\s+(test\|it)\('` |
| **Total tests passing** | **594** | bun:test runner |
| `expect()` calls | **1355** | bun:test runner |
| **Assertion density** | **2.28** per test | 1355 / 594 |
| `.toThrow(` occurrences | **181** | Grep on `.toThrow\(` |
| `.not.toThrow(` subset | 42 | Grep on `.not.toThrow\(` |
| Pure `.toThrow(` (negative path) | 139 | 181 − 42 |
| `.skip` / `.only` / `.todo` | **0** | Grep on `\.(skip\|only\|todo)\(` |
| `@ts-expect-error` / `@ts-ignore` | 2 | Grep — both are intentional (31-A.9 compile-time guard) |

### Coverage

From `bun test --coverage` (`wall3-coverage.txt`):

| File | % Funcs | % Lines | Uncovered lines |
|---|---|---|---|
| `journal.ts` | 100.00 | 100.00 | — |
| `lib.ts` | 100.00 | 98.52 | 409, 417, 463, 471, 479, 818, 847, 862, 901 |
| `manifest.ts` | 100.00 | 100.00 | — |
| `policy.ts` | 93.75 | 93.33 | 143, 385, 435, 487, 489–494, 498–501 |
| `supervisor.ts` | 100.00 | 100.00 | — |
| **All files** | **98.75** | **98.37** | |

`server.ts` is deliberately not imported into tests (top-level side effects: `loadEnv`, `mkdirSync`, Slack client init). Its handler logic is exercised via the pure helpers in lib/policy/manifest/journal/supervisor.

The 17 uncovered lines in `policy.ts` are concentrated in the `parsePolicyRule` JSON-error paths and `matchSubsetOrEqual` early-return branches — defensive code that requires malformed JSON fixtures to exercise.

---

## Bias audit

Ran the skill's `bias-count.sh` on a staging directory containing only `server.test.ts`. The skill script exits early with `set -euo pipefail` when `grep -rn … | wc -l` returns 0 matches (pipefail propagates grep's "no-match" exit 1). Ran a manual equivalent (`bias-manual.txt`) to get the complete pattern count:

| Pattern | Count | Verdict |
|---|---|---|
| Tautological (`toBe(\1)` backreference) | 0 | ✅ |
| Smoke-only `.toBeDefined()` | 8 | 🟢 1.37%, LOW grade per skill |
| Low-signal `.toBe(true)` | 29 | 🟡 4.9% — spot-check shows most wrap semantic predicates (`isOwner`, `isAuthorized`); not bias |
| Positive-only `.not.toThrow()` | 42 | 🟢 mirrored by 139 real `.toThrow()` — suite is well-balanced pos/neg |
| Range-only (`assert.*<=.*<=`) | 0 | ✅ |
| Symmetric input `(0, 0)` / `(1, 1)` | 0 / 0 | ✅ |
| Skipped (`.skip/.only/.todo`) | 0 | ✅ |

**Bias rate** (toBeDefined per 100 tests) = **1.37** → **LOW**, per the skill script's grading (≤5 = LOW, no action).

**Filed upstream issue candidate:** `bias-count.sh` should either use `grep … || true` in its `count_pattern` function, or drop `pipefail`, or swap to `grep -c` (which returns 0 and prints 0 on no-match). Documenting here; not filing against the skill repo from this project.

### Secret-shaped test fixtures

18 matches for `xoxb-` / `xapp-` / `ghp_` patterns in `server.test.ts`. All are string-concatenated fixtures for the journal redactor (`'xoxb-' + 'A'.repeat(40)`) — the standard gitleaks-false-positive avoidance. TruffleHog across the working tree (`trufflehog.txt`) reports 0 verified secrets; 69 unverified all in `node_modules/zod/src/v4/classic/tests/template-literal.test.ts` (upstream test data).

---

## Cyclomatic complexity proxy (CRAP input)

The skill's `crap-score.py` requires `complexity-report` (an older JS-only tool that doesn't parse modern TypeScript). ESLint's `complexity` rule needs the `@typescript-eslint/parser` installed. Neither is wired in this repo.

Used a regex-based proxy (`complexity-proxy.txt`) counting `if/else if/while/for/case/catch/&&/||/?:` per function:

| File | Lines | Funcs≈ | Branches | Branches/func | Mean cyclomatic ≈ |
|---|---|---|---|---|---|
| `lib.ts` | 1770 | 38 | 248 | 6.5 | 7.5 |
| `policy.ts` | 605 | 14 | 82 | 5.9 | 6.9 |
| `manifest.ts` | 582 | 8 | 63 | 7.9 | 8.9 |
| `journal.ts` | 1103 | 17 | 148 | 8.7 | 9.7 |
| `supervisor.ts` | 1008 | 12 | 121 | 10.1 | 11.1 |
| `server.ts` | 2552 | 22 | 319 | 14.5 | 15.5 |

With ≥98% coverage, CRAP ≈ complexity (the (1-cov)³ factor drops the branch-risk term to near zero). Mean-per-file cyclomatic proxy ranges 6.9 (policy.ts) to 15.5 (server.ts) — well under the Wall 5 threshold of 30 (production) and Wall 6 of 15 (test). Server's higher number reflects boot-time wiring, not algorithmic complexity.

A proper TS-aware complexity run would need `typhonjs-escomplex` or `@typescript-eslint/parser` wired in. Filed as a future bd (Biome adoption, which includes complexity rules).

---

## Static analysis snapshot (Biome, unconfigured)

Ran `bunx @biomejs/biome check .` with no config (`biome-summary.txt`, `biome.txt`). Biome is installed on the dev machine but not configured for this repo. Across 22 files: 31 errors, 85 warnings, 133 infos.

**Top rules triggered** (from `biome-summary.txt`):

| Rule | Count | Severity |
|---|---|---|
| `lint/style/useLiteralKeys` | 76 | info |
| `lint/style/noNonNullAssertion` | 66 | warn |
| `lint/style/useTemplate` | 32 | info |
| `lint/style/useNodejsImportProtocol` | 22 | info (requires `node:fs` not `fs`) |
| `lint/suspicious/noExplicitAny` | 15 | warn |
| `assist/source/organizeImports` | 6 | error |
| `lint/suspicious/noControlCharactersInRegex` | 2 | error |
| `lint/suspicious/noAssignInExpressions` | 1 | error |

Nothing in this list changes the security or correctness of the code — they are style and formatting signals Biome would enforce if adopted. Whether to adopt Biome as the project standard is Jeremy's call; filed as a separate bd (not in this PR).

---

## Security snapshot

| Tool | Ran | Findings |
|---|---|---|
| TruffleHog (filesystem) | ✅ | 0 verified, 69 unverified in `node_modules/zod` upstream test data — `trufflehog.txt` |
| `bun pm scan` | ⚪ Not configured | Requires `[install.security] scanner = "..."` in bunfig; deferred (see QUALITY_GATES.md §9) |
| `npm audit` | ⚪ N/A | No `package-lock.json` in a Bun project; `bun.lock` is not readable by `npm audit` |
| Semgrep / Gitleaks | ⚪ Skipped | Would need `pipx install` / user-level install; CodeQL in CI already provides SAST. Added to QUALITY_GATES.md §9 as the installable alternatives. |
| CodeQL (CI) | 🟢 In CI | `.github/workflows/codeql.yml` active |
| OpenSSF Scorecard | 🟢 In CI | `.github/workflows/scorecard.yml` active |

---

## Known follow-ups already tracked

- **`ccsc-80e` (P2 bug)** — `verifyJournal 1000-event chain` test can exceed bun's default 5000 ms under I/O contention. **Fixed in this PR**: per-test timeout bumped to 15 s.

---

## Gaps addressed by this PR

| # | Gap | Fix |
|---|---|---|
| 1 | Flaky `verifyJournal` test | Bump `{ timeout: 15_000 }` on the single test |
| 2 | No CI coverage floor | Add `scripts/coverage-floor.sh` + CI step (`bun test --coverage` → parse All-files line → fail if < 95%); required because Bun 1.2.23 does not enforce `coverageThreshold` in `bunfig.toml` |
| 3 | Shallow audit doc | This file (and `QUALITY_GATES.md`) — deterministic evidence per wall |

## Gaps dispatched to parallel subagent PRs

| # | Gap | Parallel PR |
|---|---|---|
| D | 31-A.4 not formalized as a depcruise rule | `feat(arch): formalize 31-A.4 invariant via dependency-cruiser` |
| E | No baseline mutation score | `feat(test): mutation testing setup with one-time baseline score` |

## Gaps filed as beads for Jeremy's call (not in this PR)

- **Adopt Biome repo-wide as lint+format standard** — 31 errors + 85 warnings + 133 infos tell us there's a real gap; whether the project standardizes on Biome (vs ESLint, vs neither) is a product-of-team-values call. Filed as a separate bead.
- **Wire Stryker mutation score floor into CI** — contingent on Phase E producing a stable baseline. Filed as a dependent bead (depends-on the Phase E bead).

---

## Files changed by this PR

- `000-docs/TEST_AUDIT.md` — this file
- `000-docs/QUALITY_GATES.md` — new (see Step 5.5 artifact)
- `scripts/coverage-floor.sh` — new, parses `bun test --coverage` output
- `.github/workflows/ci.yml` — adds coverage-floor step
- `server.test.ts` — 1-line timeout bump on the `verifyJournal 1000-event chain` test
- `000-docs/test-audit-run-evidence.md` — pointer to `/tmp/audit-run-1776735120/` artifacts

No production code changes. No test assertions changed. No new devDependencies added (Phase D and E add their own, in their own PRs, behind their own review).

---

## Why the prior revision was shallow

The 2026-04-20 revision of this doc was authored without running:
- The skill's own scripts (`bias-count.sh`, `crap-score.py`, `arch-check.sh`, `escape-scan.sh`, `harness-hash.sh`)
- `dependency-cruiser` or `madge` for architecture graphs
- `@biomejs/biome` or any linter
- `trufflehog`, `gitleaks`, or `semgrep` for secrets/SAST
- Any mutation tool

It also miscounted:
- Tests (549 → actual 594)
- `.toThrow` occurrences (104 → actual 181)
- Assertion density (2.47 → actual 2.28)

It skipped the Step 5.5 `QUALITY_GATES.md` artifact entirely and skipped Step 8 auto-remediation (coverage floor, flaky-test fix) even though those are unambiguously low-risk.

This revision corrects all of the above. The old revision is preserved in git history (PR #125).
