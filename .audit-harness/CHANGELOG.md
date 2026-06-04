# Changelog

All notable changes are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.1.5] - 2026-06-03

### Added — npm release pipeline (closes the publish-pipeline gap)

This is the first release published to npm via CI with Sigstore provenance. Until now the repo had **no release workflow** — npm was stuck at `0.1.0` while the code (and every other manifest) had advanced through `1.0.0` → `1.1.4`, four minors of CHANGELOG-documented work that never reached consumers. `npm install @intentsolutions/audit-harness` resolved to the stale `0.1.0` tarball.

- **`.github/workflows/release.yml`** (NEW): mirrors the provenance approach of `intent-eval-core`'s release workflow, adapted for this zero-dependency polyglot CLI (no pnpm, no lockfile, no TS build, no coverage). Triggers on `push` of a `v*.*.*` tag and on `workflow_dispatch`. Sets `id-token: write` for npm/Sigstore OIDC. Verifies the pushed tag matches `package.json#version` (skipped on manual dispatch since there's no tag), runs the `node bin/audit-harness.js --version` self-check + the repo's `escape-scan.sh --staged` test script (non-blocking on no-staged-diff), then `npm publish --provenance --access public`. The `NPM_TOKEN` repo secret is already configured.

### Fixed — package metadata + install.sh URLs for the `intent-audit-harness` repo rename

The GitHub repo was renamed `audit-harness` → `intent-audit-harness`, but the metadata still pointed at the old path.

- **`package.json`**: `homepage`, `repository.url`, and `bugs.url` repointed from `jeremylongshore/audit-harness` → `jeremylongshore/intent-audit-harness` (these render on npmjs.com).
- **`python/pyproject.toml` + `rust/Cargo.toml`**: project-URL fields (Homepage / Repository / Issues / Changelog / documentation) repointed to the renamed repo — these render on PyPI and crates.io.
- **`python/src/intent_audit_harness/__init__.py`**: docstring source-link repointed.
- **`README.md`**: the `curl … install.sh` line + the two "Related" skill links repointed to the renamed repo.
- **`install.sh`**: the `REPO=` variable, the usage-comment URLs at the top, and the re-run hint repointed; the default `VERSION` bumped from the stale `v0.1.0` → `v1.1.5`.

### Fixed — install.sh tarball-path glob broke after the rename

The GitHub archive tarball unpacks as `<repo>-<version>/`, which became `intent-audit-harness-1.1.5/` after the rename. The unpack-dir detection used `find … -name 'audit-harness-*'`, and `-name` matches the basename with no implicit leading wildcard, so it matched **nothing** under the new prefix — every vendored install would have failed at "could not find unpacked dir". Changed the glob to `-name '*audit-harness-*'` (leading wildcard), which matches both the current `intent-audit-harness-*` name and legacy `audit-harness-*` tags. Verified against both directory names.

### Added — README badge row

npm-version, License Apache-2.0, and Sigstore-provenance shields under the H1 (mirrors the `intent-eval-core` badge row). The "Part of the Intent Eval Platform" cross-link line is preserved.

### Changed — Version bumped to v1.1.5 across all manifests

Per the `version-canonical-check` CI gate (v1.0.2 PR #35). `package.json` (canonical), `version.txt`, `python/pyproject.toml`, `python/src/intent_audit_harness/__init__.py`, and `rust/Cargo.toml` all report `1.1.5`. (`rust/Cargo.lock` is gitignored; its working-tree entry is aligned for local cargo builds.)

### Why patch, not minor

No new CLI commands, no new flags, no API change, no script behavior change. This is release-engineering + metadata: the publish pipeline that ships the existing `1.1.x` code, plus URL corrections for the repo rename, plus the install.sh glob fix. The pinned policy scripts (`.harness-hash`) are untouched.

### Verification

- `npm pack --dry-run` → tarball contains `bin/`, `scripts/`, `README.md`, `LICENSE`, `NOTICE`, `CHANGELOG.md` per `package.json#files`
- `node bin/audit-harness.js --version` → `1.1.5`
- `bash -n install.sh` → exit 0; unpack-dir glob matches `intent-audit-harness-1.1.5` (and legacy `audit-harness-*`)
- `bash scripts/harness-hash.sh --verify` → OK (no pinned files changed)

## [v1.1.4] - 2026-05-25

### Fixed — gherkin-lint.sh prev_blank print-every-line noise (IEP P3, Gemini #71 review chain)

Closes `iah-gherkin-prev-blank-noise` (`bd_000-projects-o9q1`, P2). The third awk block in `scripts/gherkin-lint.sh` (the And-at-scenario-start checker) opened with a bare `prev_blank = 1` expression that awk interpreted as an always-true pattern with implicit `{ print }` default action — flooding stdout with every line of every feature file alongside the intentional ERROR printf. `prev_blank` was never USED anywhere in the awk script (verified via grep). Removed both touches: the top-level expression AND the assignment in the blank-line pattern (which was also unreachable for anything that mattered, since no downstream pattern read `prev_blank`). The third awk block now produces ONLY the targeted ERROR line when triggered. Verified via the same deliberate-failure test from v1.1.2 AAR — output before: full feature file printed interleaved with ERROR. Output after: just the ERROR line.

### Changed — gherkin-lint.sh process_awk_output() collapsed to single awk pass (Gemini #38 follow-up)

Closes `iah-gherkin-single-awk-opt` (`bd_000-projects-vawm`, P3). v1.1.2 introduced `process_awk_output()` with two awk subprocesses per call (one counting WARN, one counting ERROR). v1.1.4 collapses to a single awk pass via `read -r w e < <(awk '/^WARN /{w++} /^ERROR /{e++} END {print w+0, e+0}' <<< "$out")` per Gemini PR #39 verbatim suggestion. Halves the awk fork count (4 callsites × 2 subprocesses = 8 awk processes/feature → 4). Verified with mixed WARN+ERROR test: 2 WARNs + 1 ERROR in one feature file produces summary `2 warning(s), 1 error(s)` and exit 1.

### Fixed — crap-score.py exclusion sets deduplicated via EXCLUDED_DIRS constant (Gemini #71 review)

Closes `iah-crap-score-exclusion-dedup` (`bd_000-projects-niv8`, P2). Pre-v1.1.4, `scripts/crap-score.py` had TWO separate sets with overlapping intent but divergent contents:

- `ignore` set in `score_python()` (line 85): had `"reports"` but lacked `.next`, `.nuxt`, `.cache`
- `prune` set in `main()` (line 394, added v1.1.1 for `--json` input-hash walk): had `.next`, `.nuxt`, `.cache` but lacked `"reports"`

Asymmetry was a real bug: a repo with `reports/` would skip score_python's candidate scan but its `.py` files DID get hashed by the input-hash walk; opposite for `.next/.nuxt/.cache`. Fixed by extracting a single module-level constant `EXCLUDED_DIRS` (union of both prior sets) referenced by both call sites. Set contents: `.git`, `.venv`, `venv`, `node_modules`, `__pycache__`, `dist`, `build`, `target`, `.tox`, `.mypy_cache`, `.pytest_cache`, `.next`, `.nuxt`, `.cache`, `reports`.

### Changed — Shellcheck CI job version-pinned (parity with ruff v1.1.3)

Closes `iah-shellcheck-version-pin` (`bd_000-projects-v1ds`, P3). v1.1.2 (Phase A1) installed shellcheck via `apt-get install -y shellcheck` which pulls whatever Ubuntu's runner-image version happens to ship (currently 0.9.0). When the runner image upgrades shellcheck to 0.10.x or later, new rules activate silently and could surface findings in already-merged code. v1.1.4 pins to `v0.10.0` via download from the koalaman/shellcheck GitHub releases. CI step prints `shellcheck --version` for audit trail. To bump: edit `SHELLCHECK_VERSION` env in the workflow + run `shellcheck scripts/*.sh` locally + commit as explicit PR. Matches the ruff version-pin pattern from v1.1.3.

### Changed — Version bumped to v1.1.4 across all 5 manifests

Per the version-canonical-check CI gate (v1.0.2 PR #35). All 5 manifest locations now report `1.1.4`.

### Changed — `.harness-hash` regenerated

`scripts/gherkin-lint.sh` + `scripts/crap-score.py` modified; both are pinned. 2 of 9 pinned-file hashes change.

### Why patch, not minor

Pure cleanup release: dead-code removal, perf microoptimization, bug fixes for cross-call inconsistencies, CI version pin. No new CLI commands, no new flags, no API change. Consumers re-vendor / `pnpm up` and get the cleaner scripts + tighter CI transparently.

### Verification

- `shellcheck scripts/*.sh` → exit 0 (local 0.9.0; CI will run pinned 0.10.0)
- `ruff check` → `All checks passed!`
- `bash -n scripts/*.sh` → all pass
- `python3 -m py_compile scripts/crap-score.py + cli.py` → exit 0
- `bash scripts/harness-hash.sh --verify` → OK after `--init`
- gherkin-lint deliberate-failure test (And-at-start): exit 1, summary correct
- gherkin-lint mixed test (2 WARN + 1 ERROR): summary `2 warning(s), 1 error(s)`, exit 1
- Output noise gone: feature-file lines no longer printed alongside ERRORs

AAR: `000-docs/009-AA-AACR-v1.1.4-cleanup-bundle-2026-05-25.md`.

### Not bundled (separate scope)

`iah-python-wrapper-scripts-sync` (`bd_000-projects-65k4`) remains open. The Python wrapper's `python/src/intent_audit_harness/scripts/crap-score.py` (and the Rust wrapper's mirror) are stale by design — install.sh sources from canonical `scripts/` but wrapper packaging hasn't grown a build-time sync mechanism. Implementation requires choosing between hatch build-hook, Cargo build.rs, symlinks, or CI-enforced manual sync. Deferred to its own focused PR.

## [v1.1.3] - 2026-05-24

### Added — Ruff CI gate against own-code Python (IEP Convergence Debt Plan Priority 6 Phase A2)

Closes `iah-ruff` (`bd_000-projects-x9bs`, P1). New `.github/workflows/ci.yml` job `ruff (Python lint)` runs `ruff check` (version-pinned to 0.15.4 per the iah-shellcheck-version-pin lesson) against the own-code Python surface. Ruleset `select = ["B", "E", "F"]` — pyflakes (F) for dead imports + unused variables; pycodestyle errors (E) for syntax-level issues; **flake8-bugbear (B) for Python-specific bugs** (mutable default args, unreliable exception handling — added per Gemini PR #39 review after empirical confirmation that zero new findings fire on our codebase). Line length set to 120 (modern Python convention). Further ratchet (I import-order, UP pyupgrade, etc.) deferred to a future ratchet bead.

- New `ruff.toml` at repo root: lint scope = `scripts/*.py` + `python/src/intent_audit_harness/{__init__,__main__,cli}.py`; excludes `python/.venv/` + `python/src/intent_audit_harness/scripts/` + `rust/scripts/` (the last two are bundled-content mirrors of `scripts/*` — stale-sync tracked separately, see below).
- Version pinned via `pip install 'ruff==0.15.4'`; CI prints `ruff --version` for audit trail.

### Removed — 3 ruff-surfaced dead-code findings

- **`scripts/crap-score.py`**: redundant local `import hashlib, os` inside the `if args.json:` block was shadowing the module-level `import os`, causing ruff F401 against the top-level (which IS used by the same block). **Per Gemini PR #39 review (PEP 8 alignment)**, moved `hashlib` to module-level imports alongside the other stdlib imports; removed the local re-import entirely. The bandaid-comment explaining the local import is also gone.
- **`scripts/crap-score.py`**: dead local variable `metrics = rec.get("metrics", {}).get("cyclomatic", {})` in `score_rust()` (line 266; F841). Assigned but never read. The actual cyclomatic value is fetched freshly inside the loop on line 268.
- **`python/src/intent_audit_harness/cli.py`**: dead `import os` at line 12 (F401). Zero `os.*` usages in the file.

### Changed — Long-line reformat in scripts/crap-score.py

- Line 84 `ignore` set literal (155 chars) reformatted into a multi-line set literal that fits 120-char limit. Cosmetic; no behavior change.

### Changed — Version bumped to v1.1.3 across all 5 manifests

Per the version-canonical-check CI gate (v1.0.2 PR #35). All 5 manifest locations now report `1.1.3`.

### Changed — `.harness-hash` regenerated

`scripts/crap-score.py` is pinned by `.harness-hash-extra-patterns`; the dead-code removal + long-line reformat changes its hash. 1 of 9 pinned-file hashes change.

### Why patch, not minor

Pure lint-gate addition + dead-code removal. No new CLI commands, no new flags, no API change. Consumers re-vendor / `pnpm up` and get the cleaner scripts + the (new for them) ruff config transparently.

### Verification

- `ruff check` → `All checks passed!` on clean checkout
- `python3 -m py_compile scripts/crap-score.py` → exit 0
- `python3 -m py_compile python/src/intent_audit_harness/cli.py` → exit 0
- `shellcheck scripts/*.sh` → exit 0 (no regression on Phase A1)
- `bash scripts/harness-hash.sh --verify` → OK after `--init`
- CI ruff job will block any future PR that introduces a Python lint finding (F401, F841, E*, etc.)

### Follow-up bead filed

`iah-python-wrapper-scripts-sync` (new) — `python/src/intent_audit_harness/scripts/crap-score.py` is a stale mirror of `scripts/crap-score.py`, ~1 month behind canonical source. Missing the v1.1.1 `--json` envelope emission, the `which_or_none("go")` PATH guard, and the rglob-walk pruning. Same pattern likely in `rust/scripts/`. Either (a) build-time copy in the Python/Rust wrapper packaging, (b) symlink, or (c) hand-sync discipline with CI check. Currently excluded from ruff scope; exclusion drops once the sync mechanism ships.

AAR: `000-docs/008-AA-AACR-ruff-iep-P6-2026-05-24.md`.

### What unblocks next

P6 Phase A2 complete. Next-ready P6 work:

- A3: `iah-eslint-dispatcher` (`bd_000-projects-rnpy`) — eslint coverage for `bin/audit-harness.js`
- B1: `iep-shared-lint-configs` — `.audit-harness-configs/` for vendoring lint configs to consumer repos
- Plus 2 bundleable Gemini-found fixes from v1.1.2 review: `iah-gherkin-prev-blank-noise` + `iah-gherkin-single-awk-opt`

## [v1.1.2] - 2026-05-24

### Changed — Shellcheck CI gate flipped from tolerant to hard-fail (IEP Convergence Debt Plan Priority 6 Phase A1)

Closes `iah-shellcheck-hard-fail` (`bd_000-projects-4asc`, P1). The shellcheck job in `.github/workflows/ci.yml` previously ran `shellcheck scripts/*.sh || true` — warnings and errors were logged but never blocked the PR. As of this release the `|| true` suffix is removed: any shellcheck finding (warning or error) blocks the build. The locked precondition was v1.1.1 (PR #37) which addressed the 6 Gemini-flagged robustness findings — the surface was already clean enough that flipping the gate exposed exactly 3 residual dead-code findings, all fixed below.

### Removed — 3 pieces of dead code surfaced by the harder shellcheck gate

- **`scripts/bias-count.sh`**: `declare -A PATTERN_COUNTS` plus the per-call `PATTERN_COUNTS["$label"]=$count` assignment in `count_pattern()`. SC2034: the associative array was populated but never read. Per-pattern counts are still printed inline (line 61) and are aggregated into `TOTAL_BIAS` for the JSON output `bias_total` metadata field; the per-pattern breakdown was apparently intended for a richer JSON shape that was never wired. Restoring it would be a feature, not a fix; filed as deferred scope if a consumer asks.
- **`scripts/emit-evidence.sh`**: `INPUT_HASH_HEX="$(echo "$STATEMENT" | python3 -c ...)"` (formerly line 238). SC2034: computed but never read. Vestige from an earlier cosign integration; the surrounding `BLOB_FILE` construction relies on `ARTIFACT_NAME` only.
- **`scripts/gherkin-lint.sh`**: `err()` helper function. SC2317: zero call sites in the file (verified via `grep -n "\berr\b"` — only the definition matches). The helper was defined symmetrically with `warn()` but never wired up to the awk rubric or the subprocess-fallback path. Replaced with `process_awk_output()` helper (see Fixed section below).

### Fixed — gherkin-lint.sh awk subprocess undercount (silent-failure class bug; Gemini PR #38 review)

While processing the SC2317 cleanup above, Gemini's PR #38 review surfaced a deeper bug: the gherkin-lint.sh awk-fallback path printed `WARN`/`ERROR` lines via `awk printf` but those subprocesses never incremented the parent shell's `WARN_COUNT`/`ERROR_COUNT` counters. The summary line said "0 warnings, 0 errors" while errors were actively being printed; the exit code stayed 0 regardless. Exactly the silent-failure class the linter exists to surface in OTHER projects.

- **New `process_awk_output()` helper**: wraps each awk subprocess, captures its output, counts `WARN` / `ERROR` lines via inline awk (`'/^WARN /{c++} END{print c+0}'` — set-euo-pipefail safe, no `|| true` needed), increments the bash counters, then re-prints. 4 awk blocks now feed through it.
- **Verification**: deliberate-failure test against a feature with `Scenario: ... \n And ...` produces exit code 1 + summary `0 warning(s), 1 error(s)` (was: exit 0 + `0 warning(s), 0 error(s)` while still printing the ERROR line). Clean feature still exits 0.
- **Separate-scope finding**: the third awk script contains a stray top-level `prev_blank = 1` that awk treats as an always-true pattern, triggering its default print-every-line action. That's a pre-existing cosmetic issue (extra noise in script output) but not a counter bug — filed as deferred scope.

### Changed — Version bumped to v1.1.2 across all 5 manifests

Per the version-canonical-check CI gate (v1.0.2 PR #35). All 5 committed manifest locations now report `1.1.2`:

- `package.json`
- `version.txt`
- `python/pyproject.toml`
- `python/src/intent_audit_harness/__init__.py`
- `rust/Cargo.toml`

### Changed — `.harness-hash` regenerated

The self-pinning manifest is regenerated to capture the new script hashes (per `iep-P3 iah-self-pin` v1.1.0 mechanism). 3 of 9 pinned-file hashes change (the 3 modified scripts); 6 unchanged.

### Why patch, not minor

Pure dead-code removal + a CI policy tightening. No new CLI commands, no new flags, no API change, no behavioral change for any consumer. Downstream consumers re-vendor (or `pnpm up`) and get the cleaner scripts transparently.

### Verification

- `shellcheck scripts/*.sh` → exit 0 on a clean checkout (verified locally before push)
- `bash -n scripts/*.sh` → all pass
- `python3 -m py_compile scripts/crap-score.py` → exit 0
- `bash scripts/harness-hash.sh --verify` → harness-hash: OK after `--init`
- CI shellcheck job will now block on any future warning — try staging `cmd $var` (unquoted expansion) to verify the gate fires

AAR: `000-docs/007-AA-AACR-shellcheck-hard-fail-iep-P6-2026-05-24.md`.

### What this unblocks in the IEP Convergence Debt Plan

P6 Phase A1 closed. Next-ready P6 work:

- A2: `iah-ruff` — add Python ruff CI gate
- A3: `iah-eslint-dispatcher` — add eslint coverage for `bin/audit-harness.js`
- A4: `iah-script-robustness-upstream` (already shipped in v1.1.1; nothing more to do)

## [v1.1.1] - 2026-05-23

### Fixed — 6 script robustness + portability fixes (IEP Convergence Debt Plan Priority 3)

Closes `iah-script-robustness-upstream` (`bd_000-projects-qqkq`, P2). Addresses the 6 medium-severity Gemini findings surfaced when audit-harness scripts were vendored into `intent-eval-lab` via `iep-harness-hash-platform-rollout` (PR #67). All fixes are upstream-only: zero CLI surface change, zero runtime-dep change, zero policy change.

- **`scripts/escape-scan.sh`** (mktemp leak): `--staged` and `--range` modes allocate a temp file via `mktemp` to capture the diff but never clean it up. Adds `trap 'rm -f "$DIFF_SRC"' EXIT` immediately after each `mktemp` so the temp file is removed on every exit path (clean exit, REFUSE, CHALLENGE, signal). Matters most when escape-scan runs as a local git hook where temp accumulation is silent.
- **`scripts/crap-score.py`** (missing `go` PATH guard): `score_go()` called `run(["go", "test", "-coverprofile=...", ...])` without first checking that `go` is on PATH, so on systems without Go installed the subprocess raised `FileNotFoundError` and aborted the whole CRAP pass. Wraps the call in the existing `which_or_none("go")` pattern already used for `radon`, `gocyclo`, and the downstream `go tool cover` invocation.
- **`scripts/crap-score.py`** (rglob walk pruning): the `--json` input-hash computation walked every file under `root` via `rglob("*")`, only filtering `node_modules` / `.venv` after the directory had been traversed. Replaces with `os.walk` + `dirs[:] = [...]` in-place pruning, skipping `.git`, `node_modules`, `.venv`/`venv`, `__pycache__`, `dist`, `build`, `target`, `.tox`, `.mypy_cache`, `.pytest_cache`, `.next`, `.nuxt`, `.cache`. Major perf win on large repos; no behavioral change to the resulting hash for repos without pruned-extension files under those directories.
- **`scripts/emit-evidence.sh`** (shell→Python path injection): `python3 -c "import json, sys; print(json.load(open('$PKG_JSON'))['version'])"` interpolated the shell variable directly into the Python source. Paths containing single quotes (or arbitrary characters in adversarial cases) broke the parse. Now passes `$PKG_JSON` via `sys.argv[1]` — `python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['version'])" "$PKG_JSON"` — moving the path through the safe argv channel.
- **`scripts/bias-count.sh`** (per-file sha256sum fork): `find ... -exec sha256sum {} \;` spawned one `sha256sum` process per matched file. Changes the terminator to `+` so `find` batches arguments into one (or few) sha256sum invocations. Perf win on test suites with many files; output identical because the downstream `sort | sha256sum` step normalizes.
- **`scripts/harness-hash.sh`** (cross-platform sha256sum): GNU coreutils ships `sha256sum`, macOS ships `shasum -a 256`. Adds detection at script top selecting whichever is available into a `SHA256_CMD` bash array, falling back with a clear error if neither is on PATH. Both produce identical `<hash>  <file>` output, so the manifest format and downstream `awk` parsing are byte-equivalent. Enables engineer-local runs on macOS without forcing every contributor to install coreutils.

### Changed — Version bumped to v1.1.1 across all 5 manifests

Per the version-canonical-check CI gate (added in v1.0.2 PR #35). All 5 committed manifest locations now report `1.1.1`:

- `package.json`
- `version.txt`
- `python/pyproject.toml`
- `python/src/intent_audit_harness/__init__.py`
- `rust/Cargo.toml`

### Changed — `.harness-hash` regenerated

The self-pinning manifest is regenerated to capture the new script hashes (per `iep-P3 iah-self-pin` v1.1.0 mechanism). The 6 script edits change 4 of the 9 pinned-file hashes; `--init` rewrites the manifest.

### Why patch, not minor

Pure bug + portability fixes. No new flags, no new commands, no policy change, no breaking change to the manifest format. Downstream consumers re-vendor (or re-install via the polyglot installers) and get the improvements transparently.

### Why this matters for the platform

The scripts in this release are now vendored into `intent-eval-lab` (per `iep-harness-hash-platform-rollout` rollout 1, lab PR #67) and will land in `j-rig-binary-eval` next. Bug-fix patches travel via re-vendor — `AUDIT_HARNESS_VERSION=v1.1.1 curl -sSL https://raw.githubusercontent.com/jeremylongshore/audit-harness/main/install.sh | bash` for vendored consumers, `pnpm up @intentsolutions/audit-harness` for node consumers. Landing the fixes before the rollout reaches more repos avoids re-publishing buggy vendored copies that immediately need replacement.

AAR: `000-docs/006-AA-AACR-script-robustness-upstream-iep-P3-2026-05-23.md`.

### Sequencing impact on Priority 6 Phase A1

Priority 6 Phase A1 (`iah-shellcheck-hard-fail`) flips `.github/workflows/ci.yml:89` from `shellcheck scripts/*.sh || true` to hard-fail. Per the IEP Convergence Debt Plan risk-mitigation table ("Flipping shellcheck to hard-fail breaks existing audit-harness CI — mitigation: land fixes for Gemini's 6 findings FIRST, THEN flip the gate"), this release is the explicit precondition for the shellcheck flip. Phase A1 PR opens after v1.1.1 lands on main.

## [v1.1.0] - 2026-05-22

### Added — Per-repo `.harness-hash-extra-patterns` mechanism + audit-harness self-pin (IEP Convergence Debt Plan Priority 3)

Closes `iah-self-pin` (`bd_000-projects-itpl`, P1). The harness's own policy enforcement surface (scripts/*.sh + scripts/*.py + bin/audit-harness.js) is now hash-pinned at the audit-harness repo root. CI's `audit-harness list` + `harness-hash --verify` self-check steps are flipped from `|| true` exit-3 tolerance to hard-fail: any byte change to a pinned policy file without a fresh `--init` + commit of the regenerated `.harness-hash` exits 2 (HARNESS_TAMPERED) and blocks the PR.

- **`scripts/harness-hash.sh`**: NEW — reads an optional `.harness-hash-extra-patterns` file at the repo root and appends its lines to the default PATTERNS array. Comments (`#`) + blank lines ignored. Backward-compatible: repos without the file get exactly the previous behavior — consumer repos are not affected.
- **`.harness-hash-extra-patterns`** (NEW, audit-harness repo root): pins `scripts/*.sh`, `scripts/*.py`, `bin/audit-harness.js`, and the extras file itself (preventing silent edits to the self-pinning scope).
- **`.harness-hash`** (NEW, audit-harness repo root): 9-file manifest produced by `bash scripts/harness-hash.sh --init`. Committed to main.
- **`.github/workflows/ci.yml`**: `audit-harness list` + `harness-hash --verify` self-check steps drop `|| true` suffixes. Hard-fail in place. Comment block updated.

### Why minor not patch

The `.harness-hash-extra-patterns` mechanism is a new authored feature surface — repos that opt in get a new capability. Per SemVer, minor bump. Existing repos (zero adopters today; this is the first one) are unaffected.

### Why this matters

Before this release, the audit-harness CI workflow could not enforce its own policy. The "harness tests itself" design rule (CLAUDE.md rule 5) was aspirational — `audit-harness list` and `harness-hash --verify` both exited 0 when no manifest existed (intentional tolerance to avoid false-failing every PR). A silent edit to `scripts/escape-scan.sh` (the gate that REFUSES threshold-lowering changes) would pass CI. That's the failure mode this release closes.

### Cross-platform-rollout note

`iep-harness-hash-platform-rollout` (`bd_000-projects-g6zu`) unblocks on this release. The remaining 4 IEP repos (intent-eval-lab, j-rig-binary-eval, intent-rollout-gate — kernel already pinned) can now copy this pattern using their own `.harness-hash-extra-patterns` to pin per-repo policy files (CI workflow definitions, governance docs, vendored harness wrappers).

### Changed — Version bumped to v1.1.0 across all 5 manifests

Per the version-canonical-check CI gate landed in v1.0.2 (PR #35). All 5 committed manifest locations now report `1.1.0`.

AAR: `000-docs/005-AA-AACR-iah-self-pin-iep-P3-2026-05-22.md`.

## [v1.0.2] - 2026-05-21

### Chore — Polyglot manifest alignment + Apache-2.0 NOTICE inclusion in distributions (IEP Convergence Debt Plan Priority 3)

Aligned all polyglot manifests (`package.json` + `version.txt` + `python/pyproject.toml` + `python/src/intent_audit_harness/__init__.py` + `rust/Cargo.toml` + `rust/Cargo.lock`) at version `1.0.2`. Bumped from npm `v1.0.1` → `v1.0.2` (rather than aligning the PyPI/crates.io wrappers to npm's `v1.0.1`) so all four registries publish lockstep from this release forward — preserves the immutability of the already-shipped npm `v1.0.1` tarball. Added a CI gate that fails any future drift. Folded NOTICE file inclusion into Python sdist + Rust crate distributions per Apache-2.0 § 4. No CLI surface or runtime behavior changes — pure metadata + packaging alignment.

- `package.json`: version `1.0.1` → `1.0.2`
- `version.txt`: `0.2.0` → `1.0.2`
- `python/pyproject.toml`: version `0.1.0` → `1.0.2`; license `MIT` → `Apache-2.0`; PyPI classifier updated to "License :: OSI Approved :: Apache Software License"; `[tool.hatch.build.targets.sdist].include` adds `/LICENSE` + `/NOTICE` per Apache-2.0 § 4
- `python/src/intent_audit_harness/__init__.py`: `__version__` `0.1.0` → `1.0.2`
- `rust/Cargo.toml`: version `0.1.0` → `1.0.2`; license `MIT` → `Apache-2.0`; `include` adds `NOTICE` per Apache-2.0 § 4
- `rust/Cargo.lock`: package entry version `1.0.1` → `1.0.2` (file is gitignored but the working-tree state is consistent for cargo builds)
- `.github/workflows/ci.yml`: NEW `version-canonical-check` job — fails if any of the 5 tracked version locations diverge from `package.json`, or if any non-npm manifest carries a non-`Apache-2.0` license. The gate also includes a robustness check for `rust/Cargo.lock` (currently gitignored; no-ops gracefully when the file isn't present in CI checkout).

Closes beads (pending PR merge): `iah-version-drift` (bd_000-projects-uoz3), `iah-license-drift` (bd_000-projects-ck2e), `iah-version-canonical-check` (bd_000-projects-hd5y). AAR at `000-docs/004-AA-AACR-polyglot-version-license-alignment-2026-05-21.md`.

Notes for downstream consumers:

- **npm** users: `v1.0.2` is purely metadata + packaging — no observable behavior change vs. `v1.0.1`. Upgrade at your convenience.
- **PyPI + crates.io** users: this is the first published `v1.0.2` and the first published Apache-2.0 release on these registries. The prior published `0.1.0` artifacts pre-date the `v1.0.0` Apache-2.0 relicense and remain available under their original MIT terms (registry tarballs are immutable). From `v1.0.2` forward all four registries publish lockstep at the same SemVer.

## [v1.0.1] - 2026-05-20

### Fixed — NOTICE in published tarball

- Added `NOTICE` to `package.json#files` so the file ships in the npm tarball alongside `LICENSE`. Per Apache 2.0 § 4, derivatives must carry the NOTICE file's attribution text if one exists in the source. `v1.0.0` shipped the relicense to Apache 2.0 but the tarball only carried `LICENSE` — this corrects that omission.

No code, behavior, CLI, or dependency changes — packaging-only patch.

## [v1.0.0] - 2026-05-19

### Changed — License (BREAKING)

- **Relicensed from MIT to Apache 2.0.** Deliberate alignment with the rest of the Intent Eval Platform ecosystem (`intent-eval-lab`, `intent-eval-core`) so every repo ships under a single OSI-approved license with explicit patent-grant language.
- Existing `0.x` releases on npm remain available under their original MIT terms (npm tarballs are immutable). All releases `>= 1.0.0` are Apache 2.0.
- Added `NOTICE` file per Apache 2.0 best practice with copyright attribution and license summary.
- README license section updated to reflect the change with a backward-compat note.

No code, CLI surface, behavior, or runtime dependency changes in this release — license-only bump cut as MAJOR for legal clarity and consumer review signaling.

## [v0.3.0] - 2026-05-12

### Added — Evidence Bundle emission (Milestone 2 of the build journey)

- `--json` flag on every gate (`escape-scan`, `harness-hash --verify`, `arch`, `bias`,
  `gherkin-lint`, `crap`). Emits a machine-readable gate-result envelope to stdout while
  preserving the existing human-readable text on stderr. Exit codes unchanged.
- `emit-evidence` subcommand. Reads a gate-result envelope from stdin (or `--input`),
  augments it with `timestamp`, `runner`, `commit_sha`, and emits a complete
  [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
  with `predicateType` `https://evals.intentsolutions.io/gate-result/v1` per
  [`evidence-bundle/v0.1.0-draft/SPEC.md`](https://github.com/jeremylongshore/intent-eval-lab/blob/main/specs/evidence-bundle/v0.1.0-draft/SPEC.md).
  Optional `--sign` (cosign keyless or `--key`), `--rekor-url` for transparency-log push.
  OTel `agent.rollout.gate.evaluated` event when `AUDIT_HARNESS_OTEL=1` or
  `OTEL_EXPORTER_OTLP_ENDPOINT` set (best-effort no-op otherwise).
- `SEMVER.md` — explicit SemVer commitment doc covering exit codes, stream contracts,
  and the predicate URI freeze.
- `tests/regression/run-regression.sh` — backward-compat regression suite. 11 checks
  across text-mode parity, `--json` stream separation, schema validation, and the
  `emit-evidence` pipeline.
- CI: `regression` job in `.github/workflows/ci.yml` runs the regression suite on every PR.

### Changed

- `bin/audit-harness.js` dispatcher exposes the new `emit-evidence` subcommand.
- `scripts/arch-check.sh` `--json` output reshaped to the gate-result envelope shape
  (the prior single-line `{"tool","status","violations","log"}` was internal — no
  documented adopter parsed it).

### Notes

- **No breaking changes.** Pre-v0.3.0 callers see identical text-mode output and exit
  codes. The `--json` flag is purely additive.
- **CISO gate (per ISEDC v1 Q1, 2026-05-10):** pushing a signed Statement to Rekor
  against `evals.intentsolutions.io/gate-result/v1` is BLOCKED until DNSSEC + CAA
  records are verified on the namespace. The script supports unsigned envelope
  emission until that gate clears (tracked in `intent-eval-lab/.beads/` as `iel-4zr`).
- **Plan reference:** `~/.claude/plans/se-the-council-bubbly-frog.md` Milestone 2.

## [v0.2.0] - 2026-05-10

- docs: add release.yml — complete /repo-dress 21-file canon (c0298ef)
- docs: fill baseline OSS governance gaps via /repo-dress (closes #10) (29a8520)
- docs: Part 2 Workstream A upgrade landscape (c967f3e)
- docs(CLAUDE.md): add three-repo convergence section (b8255a3)
- infra: convergence Phase A.0 + A — bd init, GH templates, CI workflow, design notes (8f30db4)
- bd init: initialize beads issue tracking (ffc7597)
- feat: add PyPI and crates.io wrappers for audit-harness (9b97217)

All notable changes to `@intentsolutions/audit-harness` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-21

Initial release. Extracted from the `audit-tests` Claude Code skill v7.0.0 to enable in-repo enforcement without global skill installation.

### Added

- `audit-harness verify` — SHA-256 hash verification for pinned policy files
- `audit-harness init` — initialize/re-init the `.harness-hash` manifest
- `audit-harness list` — list pinned files
- `audit-harness escape-scan` — detect AI escape patterns in a diff (coverage threshold lowering, test deletion, architecture bypasses, test skip markers)
- `audit-harness arch` — dispatch language-appropriate architecture checker (dependency-cruiser / import-linter / ArchUnit / deptrac / arch-go)
- `audit-harness bias` — count common test-bias patterns
- `audit-harness gherkin-lint` — advisory Gherkin quality check
- `audit-harness crap` — CRAP (Complexity × Coverage) scorer for Python, JS/TS, Go, Rust

### Key design decisions

- **Scripts stay as shell/python.** Not a TypeScript port — battle-tested implementations, language-portable, minimal dependencies.
- **Thin Node CLI.** `bin/audit-harness.js` is a dispatcher only; all logic lives in `scripts/`.
- **Policy-driven thresholds.** `escape-scan.sh` reads floors from `tests/TESTING.md` in the target repo, not from the script source.
- **Zero runtime dependencies** beyond Node 18+, bash, and Python 3 (only if using `crap` command).
