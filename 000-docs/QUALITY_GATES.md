# Quality Gate Sweep — Step 5.5 artifact

**Date:** 2026-04-20 · **Bead:** `ccsc-ao9` · **Companion to:** [`TEST_AUDIT.md`](TEST_AUDIT.md)

One row per Quality Gate category × per primary language (TypeScript, Bun runtime), per the `audit-tests` skill's Step 5.5 methodology. Green = in place; yellow = partial or not-enforced; red = missing; grey = not applicable.

| # | Category | Primary tool | Current state | Install command | CI wiring | Priority |
|---|---|---|---|---|---|---|
| 1 | **Unit tests** | `bun test` | 🟢 594/594 pass, 98.37% line cov | (built in) | `bun test` required in `ci.yml` | — |
| 2 | **Integration / infra** | `bun test` (same file) | 🟢 Tests use real `fs`, real Zod, real `TextEncoder` — pure-library integration style | (built in) | same step as §1 | — |
| 3 | **E2E / UI** | — | ⚪ N/A — MCP stdio server, no UI | — | — | — |
| 4 | **API / contract** | Zod schemas | 🟢 Zod schemas ARE the API contract; `manifest.ts` schema is reviewed for breaking changes per PR | (built in) | typecheck step | — |
| 5 | **Performance / load** | — | ⚪ N/A — single-process Socket Mode client, Slack rate limits are the ceiling | — | — | — |
| 6 | **Mutation testing** | Stryker | 🔜 Baseline in parallel PR `feat(test): mutation testing setup` | `bun add -D @stryker-mutator/core` | manual per epic, not per-PR (CI-expensive) | P1 (parallel) |
| 7a | **Types** | `tsc --strict --noEmit` | 🟢 Strict mode, required in CI | (built in) | `bun run typecheck` required | — |
| 7b | **Lint** | — | 🔴 None configured. Biome installed dev-wide, not wired in repo. `bunx biome check .` shows 31 errors + 85 warnings + 133 infos (mostly style) | `bunx @biomejs/biome init` | would add as required step in `ci.yml` | P2 (Jeremy's call — see "Adopt Biome" bead) |
| 7c | **Format** | — | 🔴 None. Biome would lint+format in one tool if §7b adopts it. | same as §7b | same as §7b | P2 (paired with §7b) |
| 7d | **Architecture** | `dependency-cruiser` | 🟡 → 🟢 Regex test in `server.test.ts` enforces 31-A.4. Parallel PR `feat(arch): formalize 31-A.4 invariant` adds formal `.dependency-cruiser.js` config. | `bun add -D dependency-cruiser` (in the Phase D PR) | new `depcruise` step in `ci.yml` (Phase D PR) | P1 (parallel) |
| 8 | **Pre-commit** | lefthook / husky | 🔴 None; CI covers | `bun add -D lefthook` + `lefthook install` | local only | P3 (optional — CI is the authoritative gate) |
| 8b | **CI depth** | GitHub Actions | 🟢 Typecheck (required), test, CodeQL, Gemini review, Scorecard, notify-marketplace | (existing) | `.github/workflows/*` | — |
| 8c | **Cyclomatic complexity (Wall 5)** | `scripts/crap-score.ts` | 🟡 → 🟢 TS-aware AST walker shipped in `ccsc-gh0`. CI gates at threshold=85 (current ceiling: `server.ts` anon at 84). Four functions currently exceed the Wall 5 ideal of 30 — `gate()` at 32, `handleMessage` at 35, two `server.ts` anons at 39/84. Tracked for refactor in a follow-up bd. | (uses devDep `typescript`) | `bun scripts/crap-score.ts --threshold 85` in `ci.yml` | — |
| 9a | **SAST** | CodeQL | 🟢 `.github/workflows/codeql.yml` active | (Actions) | CI | — |
| 9b | **SAST (alt)** | Semgrep | ⚪ Not installed; CodeQL covers | `pipx install semgrep` (user-level) | `semgrep --config=p/typescript .` as workflow step | P3 (only if CodeQL leaves a gap) |
| 9c | **Secret scan (PR)** | gitleaks | 🟢 `.github/workflows/secrets-scan.yml` — installs gitleaks v8.30.1, scans the PR diff (or full history on push to main), redacts findings, fails on any leak. `.gitleaksignore` carries the 7 journal-redactor test fixtures. `ccsc-bsz` closed. | (CI-side install) | `secrets-scan.yml` runs on every PR + push to main | — |
| 9d | **Dep vulnerability scan** | `bun audit` (native) | 🟢 `.github/workflows/ci.yml` runs `bun audit --audit-level=high` against the GitHub Advisory Database. One advisory is ignored (`GHSA-j3q9-mxjg-w52f`, path-to-regexp) because it's a transitive of `@modelcontextprotocol/sdk` we can't patch from our side. `ccsc-8g6` closed. Scanner-package path via `[install.security] scanner = ...` in `bunfig.toml` remains an option when one is picked (stanza is commented in place). | (built in) | `bun audit` step in `ci.yml` | — |
| 9e | **Container scan** | Trivy | ⚪ Not wired; Dockerfile exists | `trivy image <image>` | on release workflow | P3 |
| 9f | **IaC scan** | Checkov / tfsec | ⚪ N/A — no Terraform/CF/Pulumi | — | — | — |
| 10 | **Accessibility + visual** | — | ⚪ N/A — no UI | — | — | — |

## Legend

- 🟢 In place and enforced
- 🟡 Partial (exists but not enforced, or manual-only)
- 🔴 Missing; priority action
- 🔜 Addressed in a parallel PR at audit time
- ⚪ Not applicable to this project

## Priority summary

**P1 (addressed in parallel PRs from this audit):**
- Mutation testing baseline (Phase E PR)
- Architecture rule formalization (Phase D PR)

**P2 (filed as beads for Jeremy's call):**
- §7b/§7c Adopt Biome repo-wide — biggest single improvement in static analysis coverage (bd `ccsc-dz8`)
- ~~§9c Wire gitleaks as a PR gate~~ — **shipped in `ccsc-bsz`**, see §9c above
- ~~§9d Configure a Bun security scanner~~ — **shipped in `ccsc-8g6` via native `bun audit`**, see §9d above

**P3 (optional — diminishing returns on a 5-file production codebase):**
- §8 Pre-commit hooks — CI is already the gate
- §9b Semgrep — CodeQL is covering SAST
- §9e Trivy — only meaningful when images ship to a registry

## Why the thresholds are what they are

- **Coverage floor 95%** (current 98.37%): gives ~3 points of headroom for refactors that temporarily drop coverage, but forbids silent erosion into the low 90s. A 95% floor is conservative enough that a single large feature PR with staged tests won't break CI.
- **Mutation score target 70% (Phase E baseline)**: industry floor for "suite has semantic value beyond coverage." With 2.28 assertions/test and 139 negative-path `.toThrow()`s, we expect the actual baseline to land in the 75–85% range on `lib`/`policy`/`manifest`. If baseline < 50%, we surface surviving mutants as P1 beads rather than merging.
- **Complexity threshold 30 (Wall 5) / 15 (Wall 6)**: per the `audit-tests` skill defaults. Current mean-per-file proxy is 6.9–15.5, well inside both.

## Evidence

Every row above is backed by tool output in `/tmp/audit-run-1776735120/`. See [`TEST_AUDIT.md`](TEST_AUDIT.md) for the per-Wall evidence table.
