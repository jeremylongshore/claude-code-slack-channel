# Test Audit — Post-Epic-31 Health Check

**Date:** 2026-04-20
**Commit at audit:** `2f5751d` (head of main, all Epic 31 work merged)
**Triggered by:** `/audit-tests` after session closed issue #31 (bot-manifest protocol)
**Bead:** `ccsc-n8e`

---

## TL;DR

**Suite is in excellent health.** 594 tests, 98.4% line / 98.8% function coverage, 0 skips/only/todo, healthy assertion density (2.47 expect/test), 104 negative-path `.toThrow()` assertions. Strict TypeScript, typecheck-required CI, CodeQL SAST, OpenSSF Scorecard. Architecture-level invariants (31-A.4) enforced in-repo via import-graph test.

**No P0 findings.** Real gaps exist (no linter, no mutation testing, no formal architecture tooling) but they're "mature-project polish," not correctness bugs. Flaky test is tracked (`ccsc-80e`).

**Recommendation:** Ship as-is. If Jeremy wants to invest in hardening, the highest-leverage next step is either (a) wire bun's built-in coverage into CI with a floor, or (b) add a formal architecture checker (dependency-cruiser) to make the 31-A.4 invariant type-level in addition to the existing ad-hoc test. Everything else is incremental.

---

## Seven Walls scorecard

| # | Wall | Status | Evidence |
|---|------|--------|----------|
| 1 | Acceptance (Gherkin) | ⚪ Not installed | Single-file `bun:test`; no `features/` dir |
| 2 | Unit tests | ✅ Pass | 594/594, 0 skips, 0 only, 0 todo, 0 failures |
| 3 | Coverage floor | 🟡 Measured, not enforced | `bun test --coverage` reports 98.4% lines / 98.8% funcs; no CI gate |
| 4 | Mutation kill-rate | ⚪ Not installed | No Stryker config; assertion density (2.47/test) suggests tests would kill mutants |
| 5 | CRAP on production code | ⚪ Not measured | No radon/complexity-report configured |
| 6 | CRAP on test code | ⚪ Not measured | Same |
| 7 | Architecture rules | 🟢 Ad-hoc | 31-A.4 invariant enforced via import-graph test in `server.test.ts`; no formal dependency-cruiser |

---

## Suite metrics

### Volume

| Metric | Value |
|---|---|
| Test file | `server.test.ts` (single file, 9299 LoC) |
| Production LoC | 7620 (journal + lib + manifest + policy + server + supervisor) |
| Test:code ratio | ~1.22:1 |
| Describe blocks | 75 |
| Individual tests | 549 |
| Tests per describe | 7.3 average (healthy spread) |
| `expect()` calls | 1355 |
| Assertions per test | **2.47** (>2 threshold for "tested beyond smoke") |
| Negative-path `.toThrow()` | 104 |
| Runtime | 3–5s on dev server |

### Coverage (via `bun test --coverage`)

| File | Funcs | Lines | Uncovered lines |
|---|---|---|---|
| `journal.ts` | 100% | 100% | — |
| `lib.ts` | 100% | 98.52% | 9 lines — mostly defensive `catch {}` on path validation |
| `manifest.ts` | 100% | 100% | — ✨ new module, perfect |
| `policy.ts` | 93.75% | 93.33% | 17 lines — `parsePolicyRule` entry, `matchSubsetOrEqual` early-return branches |
| `supervisor.ts` | 100% | 100% | — |
| **All files** | **98.75%** | **98.37%** | |

`server.ts` is deliberately not imported into tests (top-level side effects: `loadEnv`, `mkdirSync`, Slack client init). Its handler logic is exercised via the pure helpers in lib/policy/manifest, which carry full coverage. This is a known and reasonable architecture.

### Zero-escape posture

| Pattern | Count |
|---|---|
| `.skip(...)` | 0 |
| `.only(...)` | 0 |
| `.todo(...)` | 0 |
| `// @ts-expect-error` | 1 (intentional, part of the 31-A.9 compile-time guard) |
| `// @ts-ignore` | 0 |

---

## Bias audit

Scanned for the seven bias patterns from Clean Craftsmanship:

| Pattern | Count | Verdict |
|---|---|---|
| Tautological (`expect(x).toBe(x)`) | 0 | ✅ |
| Weak self-validation (`toBeDefined()` / `toBeTruthy()` / `toBeFalsy()`) | 10 | 🟢 Acceptable — 1.8% of tests, all are null-guards before drilling into the object with stronger assertions |
| Smoke-only (single-assertion tests with no negative case) | Not flagged | Assertion density 2.47/test suggests not a pattern |
| Identity misuse (symmetric/circular input) | 0 | ✅ |
| Mutation-insensitive (no mutation tooling to quantify) | — | Install Stryker to measure (future work) |

Spot-checked all 10 `toBeDefined`/`toBeTruthy` usages — each is followed by stronger field-level assertions on the same object (e.g. `expect(result.access).toBeDefined()` → `expect(result.code).toBe('ABCD1234')`). These are standard "null-guard + drill down" patterns, not bias.

**Secret-shaped fixtures**: 18 matches for `xoxb-` / `xapp-` / `ghp_` patterns in tests. All are deliberately string-concatenated test fixtures for the journal redactor (`'xoxb-' + 'A'.repeat(40)`) — a proven technique to prevent gitleaks false positives on committed test data.

---

## Known follow-ups already tracked

- **`ccsc-80e` (P2 bug)** — `verifyJournal 1000-event chain` test can flake at bun's 5000 ms default timeout under I/O contention. Isolation runtime is ~3 s; the test times out at ~5 s only when the full 594-test suite competes for disk. Fix: bump per-test timeout to 10 s or batch the writes. Filed during the session that shipped Epic 31-A.

---

## Gaps (ranked by leverage-per-hour)

### 🟡 P2 — real mature-project polish, not correctness-critical

1. **Coverage floor in CI** (30 min to implement)
   The coverage is already 98.4% lines; adding `bun test --coverage --coverage-threshold=95` to CI pins the floor so a future PR can't silently erode it. Low risk, high leverage.

2. **`dependency-cruiser` for Wall 7** (2–3 hours)
   The 31-A.4 invariant ("`policy.ts` never imports the manifest module") is currently enforced by an ad-hoc regex test on import specifiers. A formal checker would:
   - Catch transitive imports (today's test only checks direct).
   - Give us a single artifact that documents the full architecture rule-set.
   - Run faster than string-regex.
   Migrate the existing test to a `.dependency-cruiser.js` rule + keep the string-regex as a belt-and-suspenders backup.

3. **Flaky-test fix** (`ccsc-80e`, 10 min)
   Bump timeout on the `verifyJournal 1000-event chain` test.

### 🟢 P3 — nice-to-have, diminishing returns

4. **ESLint or Biome** (1–2 hours)
   TypeScript strict mode catches ~80% of what a linter would. A linter would add: unused-var removal, consistent-style enforcement, a few security lints (no-eval, no-unsafe-regex). Given the project is four files of production TS, the ratio of value-to-config-overhead is modest.

5. **Prettier** (30 min)
   Same story as ESLint. The code is already consistently formatted by convention. Adding Prettier would enforce it mechanically but the return is small on a small codebase.

6. **Mutation testing via Stryker** (4–6 hours initial + ongoing)
   With 98% coverage and 2.47 assertions/test, the mutation score would almost certainly be in the 70–85% range. Running Stryker once to measure would be valuable as a data point; running it on every CI run is expensive (multiplies CI time by ~20×). Recommend: run manually once per epic, not in CI.

7. **Husky / lefthook pre-commit hooks** (1 hour)
   For local typecheck + test on commit. CI already enforces. Main value is the faster feedback loop.

8. **CRAP / complexity tooling** (2–3 hours)
   `radon`-equivalent for TypeScript. With 7620 LoC in well-factored modules (lib, policy, manifest as pure-function libraries + journal/supervisor/server as stateful), complexity is not an observable problem. The team would need to agree on thresholds first, which is more of a values conversation than a tooling one.

### ⚪ Not applicable to this project

- **Gherkin/BDD (Wall 1)** — requires a product-side stakeholder authoring scenarios. This is an internal tool with a single primary operator (Jeremy); the "design doc frozen in public" pattern (`000-docs/*`) already serves as the acceptance-level artifact.
- **Fuzz / property-based** — the security-critical inputs are already Zod-validated. Adding fuzzing would exercise Zod itself, which has its own test suite upstream.
- **E2E / visual regression** — this is an MCP stdio server; no UI to E2E.
- **Chaos engineering** — the server is a single process with no distributed state.

---

## Quality Gate Sweep (Step 5.5) summary

| # | Category | Status | Notes |
|---|---|---|---|
| 1 | Unit tests | ✅ | 594 passing, 98.4% coverage |
| 2 | Integration / infra | ✅ | The tests ARE integration-style for the pure libs (real fs, real Zod, real TextEncoder) |
| 3 | E2E / UI | ⚪ N/A | MCP stdio server |
| 4 | API / contract | 🟢 | Zod schemas ARE the API contract; every tool input schema has its own describe block |
| 5 | Performance / load / chaos | ⚪ | Not applicable to a Slack Socket-Mode bot |
| 6 | Mutation + property + fuzz | ⚪ | None installed; see P3 above |
| 7 | Static analysis (lint/format/types) | 🟡 | Types: ✅ strict. Lint/format: none. |
| 8 | Pre-commit + CI depth | 🟢 | CI has typecheck + test required; no pre-commit |
| 9 | Security (SAST/DAST/secrets/deps/container/IaC) | 🟢 | CodeQL (SAST), OpenSSF Scorecard, pinned-SHA workflows, Dockerfile present |
| 10 | Accessibility + visual | ⚪ N/A | No UI |

---

## Files changed by this audit

Only this doc. No test changes, no production changes, no tooling installation — per the audit-tests skill's IMPLEMENT-mode-on-approval rule. The bead (`ccsc-n8e`) closes with this report as evidence.

---

## Decision checklist for Jeremy

If you want to keep iterating:

- [ ] File bd for "wire coverage floor in CI" (≤95% threshold)
- [ ] File bd for "migrate 31-A.4 import-graph to dependency-cruiser + keep regex backup"
- [ ] Fix `ccsc-80e` (timeout bump — 10 min)
- [ ] Decide: ESLint/Biome, or skip? (no wrong answer on a 4-file codebase)
- [ ] Decide: run Stryker once per epic, or skip? (expensive but would give a mutation score)

If you want to ship and move on: the suite is healthy. Epic 32 or any of the other P2 ready beads (`ccsc-0ss`, `ccsc-4vi`) would use your time more leverageably.
