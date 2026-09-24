# Changelog

All notable changes to `@intentsolutions/audit-harness` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-09-01

### Added

- `worktree-run` — pre-push gate runner that checks the exact ref being pushed
  in a disposable `git worktree`: `verify` + `escape-scan --range` on the push
  range fail-closed, `conform` + `audit --fast` advisory, gate-result/v1 rows
  written outside the repo. No push authority, no LLM stage, no repo writes.
  Wired as a lefthook `pre-push` job in this repo (reference recipe for
  consumers). Extracted from the no-mistakes discovery (2026-08-30): the
  isolated-worktree pre-push loop was the one idea worth keeping; the LLM
  review stage, auto-fix authority, and proxy-push were deliberately not
  adopted. Honors `AUDIT_HARNESS_DISABLE=1`.
- `bias-count` now counts source-introspection tests — a test whose only
  evidence is reading the implementation source (`inspect.getsource`, reading
  files under `src/`) instead of asserting observable behaviour of a public
  interface. Deterministic counterpart of the prose rule in the
  implement-tests auto-remediation reference; advisory like every bias
  pattern (promotion to blocking goes through `fp-rate`).

### Fixed

- `bias-count` no longer dies mid-report on a clean directory: under
  `pipefail`, a zero-match grep exited 1 and aborted the scan (truncated
  output, exit 1) before the summary — the "gate that looks like it ran"
  failure class from 1.3.1. Zero-match patterns now count as 0.
- Expanded the default `harness-hash` denominator to include package test
  scripts, `tests/TESTING.md`, common JavaScript and Python coverage/mutation
  configs, and primary CI workflow files. Previously an edit could weaken the
  command or workflow that enforced a pinned threshold without changing one of
  the few files protected by the manifest.
- Added an offline contract suite proving those files are pinned, their edits
  or removal produce `HARNESS_TAMPERED` (exit 2), and ordinary source changes do
  not require a policy re-pin.
- Accessibility detection now recognises dedicated a11y/accessibility test
  files and directories for native, QML, CLI/TUI, and other non-web stacks.
  Previously it recognised only four web dependencies and falsely advised
  projects to add irrelevant tooling despite executable accessibility tests.

> **Riding a future v2.1 routine release (descoped from 1.2.0):** OTel event-name
> polish (iah-E07b/c). The `agent.rollout.gate.evaluated` and `gate.decision.emitted`
> event names are already locked + tested on main (PRs #78, #81 per NORMATIVE
> `intent-eval-lab/000-docs/067-AT-SPEC`). Any further attribute-schema polish on
> those events is deferred to a routine v2.1 release rather than headlined here — it
> is additive telemetry refinement, not a 1.2.0 capability boundary.

## [1.3.1] - 2026-07-23

A patch release closing **five coverage-detection defects on `escape-scan`**, the
flagship gate. No CLI surface change, no new commands, no policy change — the gate
now detects escapes it previously let through. Adopters on 1.3.0 should upgrade:
two of the five were **fail-open**, meaning a real threshold-lowering escape merged
clean.

**First required dogfood (2026-07-23):** CCPI (`claude-code-plugins-plus-skills`)
made `audit-harness conform --strict` a **required** branch-protection context
(`skill-conform`, own workflow — never inside `ci-required`). See CCPI#1118.

### Fixed

- **`set -e` killed the script mid-load, producing a silent total bypass
  (fail-open).** Under `set -euo pipefail`, a `grep` in the policy-loading command
  substitution that matched nothing made the substitution non-zero, and `set -e`
  terminated `escape-scan.sh` **before a single check ran** — no output, exit 1.
  Since exit 1 is the documented CHALLENGE code, a repo whose `tests/TESTING.md`
  omitted any one of `coverage.line` / `coverage.branch` / `mutation.kill_rate`
  got **zero escape scanning** while appearing to merely warn. A blatant
  `fail_under` of 5 sailed through.
- **A non-numeric policy value poisoned every later comparison (fail-open).** The
  extracting `sed` left the line unchanged when it held no number, so
  `coverage.line: eighty` became the "floor"; every subsequent comparison then died
  on `[[: invalid arithmetic operator ]]` and the scan finished `REFUSE=0`, exit 0.
  Non-numeric values are now discarded (built-in default stands) and reported as a
  `[FLAG]`.
- **Unquoted Jest coverage keys were never matched.** The pattern required
  double-quoted keys (`"lines": <N>`), so it caught `package.json` but missed
  `jest.config.js` — the unquoted `lines: <N>` form, which is the standard JS-config
  shape. Single quotes were also missed, a one-character evasion.
- **Only the first number on a line was compared.** `{ branches: <hi>, lines: <lo> }`
  tested `branches`, passed, and never looked at `lines`. This affected the
  previously-"working" quoted form too. Every `key: value` pair on the line is now
  tested.
- **False positive from making quotes optional.** A bare `lines: 3` is a coverage
  threshold only inside a coverage config; in ordinary source it is just an object
  key, and `const x = { lines: 3 }` would have become a `REFUSE`. Coverage-key
  checks are now scoped to recognised coverage-config filenames, which loses no real
  detection (a threshold written elsewhere has no effect on coverage and so cannot
  be an escape).

### Added

- `tests/escape-scan/run-escape-scan-tests.sh` — a dedicated regression suite
  covering all five defects, wired as its own CI lane. Each defect has a test that
  fails against 1.3.0.

## [1.3.0] - 2026-07-05

### Added

- **`migration-notes` subcommand — adopter-facing migration-notes generator (iah-E05d).**
  The fourth and final acceptance criterion of the `iah-E05` SemVer regression epic
  (the first three — CLI surface snapshot, breaking-change detector, CI gate — ship
  in `tests/semver/run-semver-tests.sh`). `audit-harness migration-notes [version]`
  (`scripts/migration-notes.py`, stdlib-only, read-only, no network) turns the two
  existing sources of truth — `CHANGELOG.md` (Keep a Changelog) and `SEMVER.md`
  (the breaking-change classification table + stability guarantees) — into a single
  migration document per `000-docs/012-AT-ARCH § 11.3` ("a MAJOR bump ships
  migration notes"). No arg = the latest release; `<version>` = one version;
  `--from A --to B` = the cumulative notes across the half-open `(A, B]` range. A
  MAJOR boundary surfaces the release's `Removed`/`Changed`/`Deprecated` sections
  and appends the `SEMVER.md` breaking-change rules + "what we will never do"
  guarantees; a minor/patch boundary reports "no action required". `--json` emits a
  `migration-notes/v1` envelope. The generator does not fabricate migration steps —
  it surfaces authored release-log text, keeping notes traceable. Wired as a
  dedicated CI suite (`tests/migration-notes/`, 12 assertions). Additive minor.

## [1.2.3] - 2026-06-20

A patch release shipping a correctness fix to the CLI `emit-evidence` command. No
CLI surface, no new commands — the evidence emitter now produces kernel-valid
output where it previously did not.

### Fixed

- **`emit-evidence` now emits kernel-valid `gate-result/v1` predicate bodies (#103).**
  The CLI `emit-evidence` wrapped gate rows in an in-toto Statement declaring
  `predicateType: https://evals.intentsolutions.io/gate-result/v1`, but the predicate
  body carried the legacy draft envelope (`result`/`timestamp`), which fails
  `@intentsolutions/core`'s `GateResultV1Schema` (it forbids additional properties) —
  so a downstream `intent-rollout-gate` rejected the bundle. The emitter now builds the
  canonical body (`gate_decision`, `gate_name`, `gate_version`, `gate_reasons`,
  `coverage`, `policy_ref`, `evaluated_at`), bringing the general-purpose CLI path to
  parity with the internal `ci/emit-evidence.ts` self-gate (which already emitted
  kernel-valid rows). The post-emit predicate is now validated against a full-kernel
  fixture (`tests/fixtures/gate-result-v1.schema.json`); the partial input-envelope
  fixture stays for the gate emitters' raw rows. Surfaced by the first external-adopter
  convergence run; verified `conform | emit-evidence` → 9/9 kernel-valid →
  `intent-rollout-gate` decision `block → allow`.

## [1.2.2] - 2026-06-16

A patch release closing the polyglot publish loop. No CLI surface, runtime behavior,
or API boundary changes — only the release machinery moved. v1.2.1 published to npm
but failed PyPI (a twine bug) and crates.io (an account email-verification gate);
this release publishes all three registries cleanly.

### Fixed

- **twine now uploads only built distributions, not the `.sigstore.json` bundles (#92).** The `publish-pypi` leg's `twine upload` call is scoped to `dist/*.whl dist/*.tar.gz`, so the sigstore signature bundles emitted alongside the wheel + sdist are no longer passed to twine (which rejected them and failed the v1.2.1 PyPI publish).
- **crates.io publish goes live.** The account email-verification gate that blocked the v1.2.1 crates.io publish is now resolved, so the `publish-crates` leg publishes on this tag — closing the npm + PyPI + crates polyglot publish loop.

### Changed

- Release-preparation chore for v1.2.2 (#93).

## [1.2.1] - 2026-06-16

A patch release: release-pipeline supply-chain hardening (polyglot signing) plus
dev-dependency bumps. No CLI surface, runtime behavior, or API boundary changes —
the published artifacts are byte-identical in behavior to 1.2.0; only the release
machinery and dev tooling moved.

### Added

- **sigstore-python wheel + sdist signing (#90).** The `publish-pypi` leg now signs the built wheel and sdist with `sigstore-python` (keyless Fulcio OIDC + Rekor), so the PyPI distribution carries verifiable provenance alongside the existing npm sigstore path.
- **crates.io build-provenance attestation (#90).** The `publish-crates` leg now emits a GitHub build-provenance attestation for the published crate artifact, extending the signed-supply-chain guarantee to the Rust distribution.

### Changed

- **crates.io publish is now active (#90).** With `CARGO_REGISTRY_TOKEN` provisioned as a repository secret, the `publish-crates` leg goes live on this tag — closing the polyglot publish loop (npm + PyPI + crates.io all publish + sign from one tag).
- Bump `eslint` from 9.39.4 to 10.5.0 (#71).
- Bump `jeremylongshore/intent-rollout-gate` GitHub Action pin from 0.1.0 to 0.2.0 (#86).
- Bump `crate-ci/typos` from 1.29.4 to 1.47.2 (#87).
- Release-preparation chore for v1.2.1 (#91).

## [1.2.0] - 2026-06-15

A minor release: the provider credential gate (`cred-gate`, iah-E08), the locked
OTel runtime-event surface (`agent.rollout.gate.evaluated` + `gate.decision.emitted`,
iah-E07), shared vendorable lint configs, wrapper-mirror drift-guard CI, and tailnet
CI-failure alerting — all additive, with the zero-runtime-dependency guarantee
preserved.

> **Why minor, not patch:** A new CLI-adjacent gate surface (`cred-gate`) and new authored feature surfaces (shared lint configs, the locked OTel event taxonomy, the wrapper drift-guard lane). Per SemVer this is a minor bump. No CLI command was renamed or removed; the change is purely additive and the published tarball stays zero-runtime-dependency.

### Added

- **Provider credential gate (`cred-gate`, iah-E08) (#77).** A new gate that asserts provider credentials PASS/FAIL with full redaction + spillover coverage (`scripts/cred-gate.sh`).
- **Credential-leak fixtures + failure-mode docs (#80).** Full-catalog fixture coverage for the cred-gate's redaction + spillover behavior (iah-E08a/E08b).
- **OTel runtime events on `emit-evidence` (iah-E07) (#81).** Emits `agent.rollout.gate.evaluated` (the per-gate evaluation event, name + attributes locked + tested, iah-E07a) and `gate.decision.emitted` (the gate-decision event, iah-E07b) per the NORMATIVE `intent-eval-lab/000-docs/067-AT-SPEC` runtime-event taxonomy.
- **Shared, vendorable lint configs (#85).** `.audit-harness-configs/` (markdownlint / yamllint / ruff / shellcheck) is the canonical config set the IEP repos vendor + extend; `install.sh` now vendors both `scripts/` and `configs/`. CLAUDE.md cross-references the lab specs.
- **Advisory `typos` spell-check CI lane (#83)** and **advisory `actionlint` CI lane (#84).**
- **ntfy CI-failure alert over the tailnet (#79).** CI failures fan out a notification to the private tailnet ntfy topic.

### Changed

- **Provider credential gate + OTel head landed first (#77).** The `cred-gate` head and the OTel `gate.decision.emitted` decision event landed together; PR #78 then renamed the gate-decision event to `gate.decision.emitted` to align with the 067-AT-SPEC runtime-event taxonomy.
- **Dogfood AAR (iah-E10d) (#88).** First-downstream-adopter run captured at `000-docs/013-AA-AACR-rollout-gate-dogfood-iah-E10-2026-06-15.md`.
- Release-preparation chore for v1.2.0 (#89).

### Fixed

- **Bundled wrapper mirrors resynced to canonical + drift-guard CI lane (iah-65k4) (#82).** The Python (`python/src/intent_audit_harness/scripts/`) and Rust (`rust/scripts/`) bundled copies of `crap-score.py` were stale mirrors of canonical `scripts/`; this resyncs them and adds a CI lane that fails on any future drift between canonical and the bundled mirrors.

## [1.1.8] - 2026-06-13

Ships the iah-E06 production-signing pre-flight gate to downstream consumers, plus
the comprehensive PP-PLAN-040 supply-chain + hygiene wave, crap-score backend
repairs, and a SemVer contract-pin test suite.

> **Why patch, not minor:** The pre-flight scripts shipped to the repo in earlier PRs (#70, #75); this patch propagates them to npm consumers via a version bump. No new public CLI commands or flag changes in this release boundary.

### Added

- **DNSSEC + CAA production-signing pre-flight (iah-E06) (#70).** Before a production-mode `emit-evidence` run signs canonical bytes, two deterministic pre-flight scripts assert the signing domain (`evals.intentsolutions.io`) is cryptographically sound — `scripts/dnssec-check.sh` verifies the DNSSEC chain is present and validates; `scripts/caa-check.sh` verifies the CAA records authorize the signing certificate authority. Both fail closed: any error, missing record, or unreachable resolver blocks the signing path rather than emitting an unverifiable attestation. Staging/draft emit is unaffected.
- **Supply-chain + hygiene + kernel-shadow detector (#69).** PyPI/crates publish wiring, dependabot polyglot coverage, lefthook, eslint, a bash-version floor, a kernel-shadow detector, and a crap-score dot-dir fix landed as one supply-chain wave.
- **`install.sh` completeness + per-repo blueprint + golden-master stdout suite (#63).** The vendored-install path now ships a complete traceable copy, plus a golden-master fitness function pinning the raw stdout of the scorers whose output is a downstream contract.
- **SemVer CLI/output-contract pin test (#65).** A test that pins the CLI + output contract so a MAJOR-worthy change fails CI rather than slipping out as a patch.

### Changed

- **`currency`: one pin per upstream surface + advisory poll-freshness SLA rename (#68).** Each tracked upstream (mcp-spec, skill-md-schema, claude-code, gate-result-predicate, anthropic-sdk, agentskills-spec) carries its own pin relation so the pin's own staleness is detectable per-upstream rather than as one opaque scalar.
- **Version bumped to 1.1.8 across all manifests (#76).** Per the `version-canonical-check` CI gate: `package.json` (canonical), `version.txt`, `python/pyproject.toml`, `python/src/intent_audit_harness/__init__.py`, and `rust/Cargo.toml` all report `1.1.8`.
- **audit-harness self-adopts the intent-rollout-gate Action (#74).** CI dogfoods the downstream rollout-gate Action — graduation criterion 5 / M6 first downstream adopter.
- Bump `DavidAnson/markdownlint-cli2-action` from 17 to 23 (#49); bump `actions/setup-node` from 4 to 6 (#61); record the public gist id for sweep/release tooling (#67).

### Fixed

- **Query a trusted validating resolver in the DNSSEC + CAA pre-flight (#75).** The pre-flight previously trusted the ambient resolver, which may not validate DNSSEC. Both scripts now query known validating resolvers (`1.1.1.1`, `8.8.8.8`) and require the authenticated-data (AD) flag plus an `RRSIG` on the answer. A resolver that does not set AD, or an answer with no RRSIG, is treated as a validation failure (fail-closed) rather than a pass.
- **crap-score Go/JS scoring backends repaired + 3 bash defects from the umbrella review (#66).**
- **Evidence-integrity bugs + SHA256 portability + kernel schema URL (#64).**

## [1.1.7] - 2026-06-08

A CI-only patch keeping the dashboard evidence-emit job runnable.

### Fixed

- **`emit-evidence` job needs Node 22 for `--experimental-strip-types` (nr75.12) (#60).** The CI-only `emit-evidence` TypeScript runner uses Node's experimental type-stripping, which requires Node 22; the job's Node version is bumped accordingly. No published-artifact change — the `ci/` emitter is excluded from the npm tarball.

## [1.1.6] - 2026-06-08

A minor release: the read-only "comprehensive audit, on any repo" brain
(`classify` → `conform` → `audit` → `scan` → `currency`), the registry-projection +
FP-rate safety spine, and the CI-only kernel-emitting evidence path for the
dashboard (nr75.12) — all additive, with the zero-runtime-dependency guarantee
preserved. (Note: an earlier CHANGELOG draft attributed this PP-PLAN-040 verb set
to 1.2.0; it actually shipped here in 1.1.6 via PRs #52–#59.)

> **Why minor, not patch:** Multiple new read-only CLI verbs (`classify`, `conform`, `audit`, `scan`, `currency`) and new authored feature surfaces (the audit-profile data spec, the registry datum, the CI-only evidence emit). Per SemVer this is a minor bump. No CLI command was renamed or removed; the change is purely additive and the published tarball stays zero-runtime-dependency.

### Added

- **`classify` verb + `audit-profile/v1` data-spec (PP-PLAN-040 Phase 0+1) (#53).** `audit-harness classify [repo]` (`scripts/classify.py`, stdlib-only) is a read-only repository classifier: it detects the UNION of repo-type + Claude-artifact classifications, resolves the gate set against the canonical `schemas/audit-profile/registry.v1.json` datum, records `registry_hash`, and emits an `audit-profile/v1` value to stdout — **never writes to the repo**. The `audit-profile/v1` schema is closed, versioned, and hash-bearing, mirroring `gate-result/v1`; its four invariants: classifications are a UNION (not a winner), `unresolved[]` is the only Claude-refinable surface, `waived ⇒ disabled` (allOf-enforced), `registry_hash` makes a profile reproducible. Safety levers: an `INDETERMINATE` result class (infra failure ≠ policy failure), per-command timeout supervision via `AUDIT_HARNESS_TIMEOUT`, the `AUDIT_HARNESS_DISABLE=1` kill-switch, and an engineer-owned `.audit-harness.yml` override. `schemas/` now ships in the npm package (`files`).
- **`conform` verb + bundled content-addressed schemas (PP-PLAN-040 Phase 2) (#54).** `audit-harness conform [repo]` (`scripts/conform.py`, stdlib + PyYAML): for every `dimension: conformance` gate in the repo's `audit-profile/v1`, locates the artifact(s) and emits a `gate-result/v1` row — never writes, never live-fetches. Bundled content-addressed schemas (`schemas/conform/v1/`: `skillmd-frontmatter`, `mcp-config`, `plugin-manifest`, `agent-frontmatter`) form the deterministic structural floor, checked by an embedded subset validator (not ajv) for reproducible signed evidence; each schema's sha256 is recorded in the row's `policy_hash`. Genuinely-external formats shell out (OpenAPI → `spectral`, GitHub Action → `yamllint`); a missing tool produces ADVISORY indeterminate, never a false FAIL. Advisory-first; `--strict` (or an engineer-promoted blocking gate) turns a violation into FAIL.
- **`audit` testing-depth gate-runner (PP-PLAN-040 Phase 3 / E5) (#56).** `audit-harness audit [repo]` (`scripts/audit.py`, stdlib): for every `dimension: testing-depth` gate, runs the bundled `crap` scorer and per-pyramid-layer presence heuristics (unit/integration/e2e/smoke/perf/a11y/contract/migration/property-based/fuzz/sanitizers). Layer present → PASS; absent → ADVISORY(warn); not statically assessable → ADVISORY indeterminate. `--fast` (default, presence heuristics only) / `--deep` (adds crap-score) / `--strict` (gap on a blocking gate → FAIL). Deliberately does NOT execute the repo's test suite — running untrusted suites is the repo's own CI's job.
- **`scan` security/hygiene/skill-quality gate-runner (PP-PLAN-040 Phase 4 / E6) (#57).** `audit-harness scan [repo]` (`scripts/scan.py`, stdlib): for every `dimension: security | hygiene | skill-quality` gate, emits a `gate-result/v1` row via three strategies — local (deterministic README presence), shell-out (gitleaks / osv-scanner / semgrep / syft / markdownlint / lychee; clean → PASS, findings → ADVISORY(error), absent → ADVISORY indeterminate), and consume (`skill-behavioral` ingests a j-rig Evidence Bundle verdict via `--jrig-verdict`). Advisory-first; `--strict` turns a finding/gap into FAIL. **Security note:** on first run this gate caught — and this release redacts from HEAD — a PyPI publish token pasted as a literal value in `python/PUBLISH.md`. The value remains in git history and must be rotated at the registry (tracked separately); the doc now carries a placeholder.
- **`currency` advisory upstream-currency report (PP-PLAN-040 Phase 5 / E7) (#58).** `audit-harness currency` (`scripts/currency.py`, stdlib): reads the per-upstream-identity pin relation (`schemas/currency/pins.v1.json`) and reports which pins are themselves stale (`checked_at` older than the pin's staleness window). No exit-code authority (always exit 0), no live-fetch, no auto-fix — `/sync-testing-harness` consumes the report to open advisory bump PRs; it never reddens a build. `--today YYYY-MM-DD` makes reports reproducible.
- **Registry projection + FP-rate harness (PP-PLAN-040 E2: c2b + c2e) (#55).** `audit-harness gen-layer-applicability` projects `schemas/audit-profile/registry.v1.json` into `schemas/audit-profile/layer-applicability.md` (the doc is now a projection of the registry datum, not a hand-maintained parallel source — CI gate `layer-applicability-drift` enforces it). `audit-harness fp-rate` measures each gate's false-positive / false-negative rate over a labeled corpus — the metric that gates advisory→blocking promotion. `docs/gate-promotion.md` documents the FP-rate ≤ 5% promotion bar.
- **CI-only signed evidence emit for the intent-eval-dashboard (nr75.12) (#59).** `ci/emit-evidence.ts` + `ci/assemble-manifest.ts` run the real deterministic self-gate (`harness-hash --verify`), shape it into a kernel `gate-result/v1` + `EvidenceBundle` (fail-closed against `@intentsolutions/core`), cosign-sign the canonical bytes (Fulcio OIDC + Rekor), and assemble the `report-manifest.json` the dashboard reports hub (labs.intentsolutions.io) re-verifies at ingest. Zero-dep guarantee preserved: the emitter lives in `ci/` (excluded from `package.json#files`) and the kernel is installed CI-only via `npm i --no-save`.

### Changed

- **Finished the `intent-audit-harness` rename in public contributor docs (#52).**

## [1.1.5] - 2026-06-03

> **Why patch, not minor:** No new CLI commands, no new flags, no API change, no script behavior change. This is release-engineering + metadata: the publish pipeline that ships the existing `1.1.x` code, plus URL corrections for the repo rename, plus the install.sh glob fix. The pinned policy scripts (`.harness-hash`) are untouched.

### Added

- **npm release pipeline (closes the publish-pipeline gap).** This is the first release published to npm via CI with Sigstore provenance. Until now the repo had **no release workflow** — npm was stuck at `0.1.0` while the code (and every other manifest) had advanced through `1.0.0` → `1.1.4`, four minors of CHANGELOG-documented work that never reached consumers. `npm install @intentsolutions/audit-harness` resolved to the stale `0.1.0` tarball. New `.github/workflows/release.yml` mirrors the provenance approach of `intent-eval-core`'s release workflow, adapted for this zero-dependency polyglot CLI (no pnpm, no lockfile, no TS build). Triggers on `push` of a `v*.*.*` tag and on `workflow_dispatch`, sets `id-token: write` for npm/Sigstore OIDC, verifies the pushed tag matches `package.json#version`, runs the `--version` self-check + `escape-scan.sh --staged`, then `npm publish --provenance --access public`.
- **README badge row.** npm-version, License Apache-2.0, and Sigstore-provenance shields under the H1 (mirrors the `intent-eval-core` badge row). The "Part of the Intent Eval Platform" cross-link line is preserved.

### Changed

- **Version bumped to v1.1.5 across all 5 manifests.** Per the `version-canonical-check` CI gate (v1.0.2 PR #35). `package.json` (canonical), `version.txt`, `python/pyproject.toml`, `python/src/intent_audit_harness/__init__.py`, and `rust/Cargo.toml` all report `1.1.5`.

### Fixed

- **Package metadata + `install.sh` URLs for the `intent-audit-harness` repo rename.** The GitHub repo was renamed `audit-harness` → `intent-audit-harness`, but the metadata still pointed at the old path. `package.json` (`homepage`, `repository.url`, `bugs.url`), `python/pyproject.toml` + `rust/Cargo.toml` project-URL fields, `python/src/intent_audit_harness/__init__.py` docstring source-link, `README.md` (the `curl … install.sh` line + two "Related" skill links), and `install.sh` (the `REPO=` variable, usage-comment URLs, re-run hint, and the default `VERSION` bumped `v0.1.0` → `v1.1.5`) were all repointed to the renamed repo.
- **`install.sh` tarball-path glob broke after the rename.** The GitHub archive tarball unpacks as `<repo>-<version>/`, which became `intent-audit-harness-1.1.5/` after the rename. The unpack-dir detection used `find … -name 'audit-harness-*'`, and `-name` matches the basename with no implicit leading wildcard, so it matched **nothing** under the new prefix — every vendored install would have failed. Changed the glob to `-name '*audit-harness-*'` (leading wildcard), matching both the current `intent-audit-harness-*` name and legacy `audit-harness-*` tags.

## [1.1.4] - 2026-05-25

> **Why patch, not minor:** Pure cleanup release: dead-code removal, perf microoptimization, bug fixes for cross-call inconsistencies, CI version pin. No new CLI commands, no new flags, no API change. AAR: `000-docs/009-AA-AACR-v1.1.4-cleanup-bundle-2026-05-25.md`.

### Changed

- **`gherkin-lint.sh process_awk_output()` collapsed to a single awk pass (Gemini #38 follow-up).** Closes `iah-gherkin-single-awk-opt` (P3). v1.1.2 introduced `process_awk_output()` with two awk subprocesses per call; v1.1.4 collapses to a single awk pass, halving the awk fork count (4 callsites × 2 subprocesses → 4). Verified with a mixed WARN+ERROR test.
- **Shellcheck CI job version-pinned (parity with ruff v1.1.3).** Closes `iah-shellcheck-version-pin` (P3). v1.1.2 installed shellcheck via `apt-get` which pulls whatever Ubuntu's runner image ships; v1.1.4 pins to `v0.10.0` downloaded from the koalaman/shellcheck GitHub releases so runner-image upgrades can't silently activate new rules. CI prints `shellcheck --version` for the audit trail.
- **Version bumped to v1.1.4 across all 5 manifests** and **`.harness-hash` regenerated** (2 of 9 pinned-file hashes change: `gherkin-lint.sh` + `crap-score.py`).

### Fixed

- **`gherkin-lint.sh` `prev_blank` print-every-line noise (Gemini #71 review chain).** Closes `iah-gherkin-prev-blank-noise` (P2). The third awk block (the And-at-scenario-start checker) opened with a bare `prev_blank = 1` expression that awk interpreted as an always-true pattern with implicit `{ print }` — flooding stdout with every line of every feature file alongside the intentional ERROR printf. `prev_blank` was never read anywhere; both touches were removed so the block produces ONLY the targeted ERROR line.
- **`crap-score.py` exclusion sets deduplicated via an `EXCLUDED_DIRS` constant (Gemini #71 review).** Closes `iah-crap-score-exclusion-dedup` (P2). Two separate sets with overlapping intent but divergent contents — `ignore` in `score_python()` (had `reports`, lacked `.next`/`.nuxt`/`.cache`) and `prune` in `main()` (had `.next`/`.nuxt`/`.cache`, lacked `reports`) — caused real asymmetric skips. Extracted to a single module-level `EXCLUDED_DIRS` union referenced by both call sites.

## [1.1.3] - 2026-05-25

> **Why patch, not minor:** Pure lint-gate addition + dead-code removal. No new CLI commands, no new flags, no API change. AAR: `000-docs/008-AA-AACR-ruff-iep-P6-2026-05-24.md`.

### Added

- **Ruff CI gate against own-code Python (IEP Convergence Debt Plan Priority 6 Phase A2).** Closes `iah-ruff` (P1). New `ci.yml` job `ruff (Python lint)` runs `ruff check` (version-pinned to 0.15.4 per the shellcheck-version-pin lesson) against the own-code Python surface. Ruleset `select = ["B", "E", "F"]` — pyflakes (F), pycodestyle errors (E), and flake8-bugbear (B) per Gemini PR #39 review. Line length 120. New `ruff.toml` at repo root scopes lint to `scripts/*.py` + the CLI files and excludes the bundled-content mirrors (stale-sync tracked separately).

### Changed

- **Long-line reformat in `scripts/crap-score.py`.** The 155-char `ignore` set literal reformatted into a multi-line set literal under the 120-char limit. Cosmetic; no behavior change.
- **Version bumped to v1.1.3 across all 5 manifests** and **`.harness-hash` regenerated** (1 of 9 pinned-file hashes change: `crap-score.py`).

### Removed

- **3 ruff-surfaced dead-code findings.** `crap-score.py`: a redundant local `import hashlib, os` inside the `if args.json:` block (shadowing the used module-level `import os`, F401) was removed and `hashlib` moved to module-level imports per Gemini PR #39; and a dead local `metrics = …` in `score_rust()` (F841). `cli.py`: a dead `import os` (F401, zero `os.*` usages).

## [1.1.2] - 2026-05-24

> **Why patch, not minor:** Pure dead-code removal + a CI policy tightening. No new CLI commands, no new flags, no API change, no behavioral change for any consumer. AAR: `000-docs/007-AA-AACR-shellcheck-hard-fail-iep-P6-2026-05-24.md`.

### Changed

- **Shellcheck CI gate flipped from tolerant to hard-fail (IEP Convergence Debt Plan Priority 6 Phase A1).** Closes `iah-shellcheck-hard-fail` (P1). The shellcheck job previously ran `shellcheck scripts/*.sh || true` — findings were logged but never blocked the PR. The `|| true` suffix is removed: any shellcheck finding (warning or error) now blocks the build. The locked precondition was v1.1.1 (PR #37), which addressed the 6 Gemini-flagged robustness findings.
- **Version bumped to v1.1.2 across all 5 manifests** and **`.harness-hash` regenerated** (3 of 9 pinned-file hashes change).

### Removed

- **3 pieces of dead code surfaced by the harder shellcheck gate.** `bias-count.sh`: `declare -A PATTERN_COUNTS` + its per-call assignment (SC2034 — populated, never read). `emit-evidence.sh`: `INPUT_HASH_HEX=$(…)` (SC2034 — computed, never read; vestige of an earlier cosign integration). `gherkin-lint.sh`: the `err()` helper (SC2317 — zero call sites), replaced with `process_awk_output()`.

### Fixed

- **`gherkin-lint.sh` awk subprocess undercount (silent-failure class bug; Gemini PR #38 review).** The awk-fallback path printed `WARN`/`ERROR` lines via `awk printf`, but those subprocesses never incremented the parent shell's `WARN_COUNT`/`ERROR_COUNT` — the summary said "0 warnings, 0 errors" while errors were actively printed and the exit code stayed 0. Exactly the silent-failure class the linter exists to surface elsewhere. The new `process_awk_output()` helper wraps each awk subprocess, counts `WARN`/`ERROR` lines via inline awk, increments the bash counters, then re-prints. Verified: a deliberate failure now exits 1 with `0 warning(s), 1 error(s)`.

## [1.1.1] - 2026-05-23

> **Why patch, not minor:** Pure bug + portability fixes. No new flags, no new commands, no policy change, no breaking change to the manifest format. These scripts are now vendored into `intent-eval-lab` (PR #67); landing the fixes before the rollout reaches more repos avoids re-publishing buggy vendored copies.

### Fixed

- **6 script robustness + portability fixes (IEP Convergence Debt Plan Priority 3).** Closes `iah-script-robustness-upstream` (P2). Addresses the 6 medium-severity Gemini findings surfaced when the scripts were vendored into `intent-eval-lab` (PR #67). All fixes are upstream-only — zero CLI surface, runtime-dep, or policy change:
  - **`escape-scan.sh`** (mktemp leak): adds `trap 'rm -f "$DIFF_SRC"' EXIT` after each `mktemp` so the temp file is removed on every exit path (matters most when escape-scan runs as a local git hook).
  - **`crap-score.py`** (missing `go` PATH guard): `score_go()` now wraps the `go test` call in the existing `which_or_none("go")` pattern, so a system without Go no longer raises `FileNotFoundError` and aborts the whole CRAP pass.
  - **`crap-score.py`** (rglob walk pruning): the `--json` input-hash walk now uses `os.walk` + in-place `dirs[:]` pruning (skipping `.git`, `node_modules`, `.venv`/`venv`, `__pycache__`, `dist`, `build`, `target`, `.tox`, `.mypy_cache`, `.pytest_cache`, `.next`, `.nuxt`, `.cache`) — a major perf win on large repos with no hash change for clean repos.
  - **`emit-evidence.sh`** (shell→Python path injection): the package-version read now passes `$PKG_JSON` via `sys.argv[1]` instead of interpolating the shell variable into the Python source, so paths containing single quotes no longer break the parse.
  - **`bias-count.sh`** (per-file sha256sum fork): `find … -exec sha256sum {} \;` changed to `… +` so `find` batches arguments into one (or few) invocations — output identical (the downstream `sort | sha256sum` normalizes).
  - **`harness-hash.sh`** (cross-platform sha256sum): adds detection selecting `sha256sum` (GNU) or `shasum -a 256` (macOS) into a `SHA256_CMD` array, enabling engineer-local runs on macOS without coreutils.

### Changed

- **Version bumped to v1.1.1 across all 5 manifests** and **`.harness-hash` regenerated** (4 of 9 pinned-file hashes change). AAR: `000-docs/006-AA-AACR-script-robustness-upstream-iep-P3-2026-05-23.md`.

## [1.1.0] - 2026-05-22

> **Why minor, not patch:** The `.harness-hash-extra-patterns` mechanism is a new authored feature surface — repos that opt in get a new capability. Before this release the audit-harness CI workflow could not enforce its own policy; a silent edit to `escape-scan.sh` (the gate that REFUSES threshold-lowering changes) would pass CI. That is the failure mode this release closes.

### Added

- **Per-repo `.harness-hash-extra-patterns` mechanism + audit-harness self-pin (IEP Convergence Debt Plan Priority 3).** Closes `iah-self-pin` (P1). The harness's own policy-enforcement surface (`scripts/*.sh` + `scripts/*.py` + `bin/audit-harness.js`) is now hash-pinned at the repo root. CI's `audit-harness list` + `harness-hash --verify` self-check steps flip from `|| true` exit-3 tolerance to hard-fail: any byte change to a pinned policy file without a fresh `--init` + commit of the regenerated `.harness-hash` exits 2 (HARNESS_TAMPERED) and blocks the PR.
  - **`scripts/harness-hash.sh`** (new): reads an optional `.harness-hash-extra-patterns` file at the repo root and appends its lines to the default PATTERNS array. Backward-compatible — repos without the file get exactly the previous behavior.
  - **`.harness-hash-extra-patterns`** (new): pins `scripts/*.sh`, `scripts/*.py`, `bin/audit-harness.js`, and the extras file itself.
  - **`.harness-hash`** (new): 9-file manifest produced by `bash scripts/harness-hash.sh --init`, committed to main.
  - **`.github/workflows/ci.yml`**: the self-check steps drop their `|| true` suffixes.

### Changed

- **Version bumped to v1.1.0 across all 5 manifests.** Per the `version-canonical-check` CI gate landed in v1.0.2 (PR #35). AAR: `000-docs/005-AA-AACR-iah-self-pin-iep-P3-2026-05-22.md`.

## [1.0.2] - 2026-05-21

### Changed

- **Polyglot manifest alignment + Apache-2.0 NOTICE inclusion in distributions (IEP Convergence Debt Plan Priority 3).** Aligned all polyglot manifests at version `1.0.2`, bumping from npm `v1.0.1` → `v1.0.2` (rather than aligning the PyPI/crates wrappers to npm's `v1.0.1`) so all four registries publish lockstep from this release forward — preserving the immutability of the already-shipped npm `v1.0.1` tarball. Per-file: `package.json` `1.0.1` → `1.0.2`; `version.txt` `0.2.0` → `1.0.2`; `python/pyproject.toml` `0.1.0` → `1.0.2` (license `MIT` → `Apache-2.0`, classifier updated, sdist `include` adds `/LICENSE` + `/NOTICE`); `python/src/intent_audit_harness/__init__.py` `__version__` → `1.0.2`; `rust/Cargo.toml` `0.1.0` → `1.0.2` (license `MIT` → `Apache-2.0`, `include` adds `NOTICE`); `rust/Cargo.lock` package entry `1.0.1` → `1.0.2`.
- Folded NOTICE-file inclusion into the Python sdist + Rust crate distributions per Apache-2.0 § 4. No CLI surface or runtime behavior changes — pure metadata + packaging alignment.

### Added

- **`version-canonical-check` CI job (#35).** Fails if any of the 5 tracked version locations diverge from `package.json`, or if any non-npm manifest carries a non-`Apache-2.0` license. Includes a robustness check for the gitignored `rust/Cargo.lock`. Closes `iah-version-drift`, `iah-license-drift`, `iah-version-canonical-check`. AAR: `000-docs/004-AA-AACR-polyglot-version-license-alignment-2026-05-21.md`.

## [1.0.1] - 2026-05-20

### Fixed

- **NOTICE in the published tarball.** Added `NOTICE` to `package.json#files` so the file ships in the npm tarball alongside `LICENSE`. Per Apache 2.0 § 4, derivatives must carry the NOTICE file's attribution text if one exists in the source. `v1.0.0` shipped the relicense to Apache 2.0 but the tarball only carried `LICENSE` — this corrects that omission. No code, behavior, CLI, or dependency changes — packaging-only patch.

## [1.0.0] - 2026-05-19

### Changed

- **Relicensed from MIT to Apache 2.0 (BREAKING) (#32).** Deliberate alignment with the rest of the Intent Eval Platform ecosystem (`intent-eval-lab`, `intent-eval-core`) so every repo ships under a single OSI-approved license with explicit patent-grant language. Existing `0.x` releases on npm remain available under their original MIT terms (npm tarballs are immutable); all releases `>= 1.0.0` are Apache 2.0. README license section updated with a backward-compat note. No code, CLI surface, behavior, or runtime-dependency changes — license-only bump cut as MAJOR for legal clarity and consumer-review signaling.
- **Terminology: matcher-map → Intentional Mapping (per ISEDC v2).**

### Added

- **`NOTICE` file** per Apache 2.0 best practice with copyright attribution and license summary.

## [0.3.0] - 2026-05-12

> Documented for completeness — the `--json` + `emit-evidence` work landed in the
> source tree as the v0.3.0 milestone but a `v0.3.0` git tag was never cut; the next
> published tag was `v1.0.0`. Kept here so the Milestone-2 capability set is not lost.
>
> **Notes:**
>
> - **No breaking changes.** Pre-v0.3.0 callers see identical text-mode output and exit codes; `--json` is purely additive.
> - **CISO gate (per ISEDC v1 Q1, 2026-05-10):** pushing a signed Statement to Rekor against `evals.intentsolutions.io/gate-result/v1` is BLOCKED until DNSSEC + CAA records are verified on the namespace.

### Added

- **Evidence Bundle emission (Milestone 2 of the build journey).** A `--json` flag on every gate (`escape-scan`, `harness-hash --verify`, `arch`, `bias`, `gherkin-lint`, `crap`) emits a machine-readable gate-result envelope to stdout while preserving the existing human-readable text on stderr; exit codes unchanged.
- **`emit-evidence` subcommand.** Reads a gate-result envelope from stdin (or `--input`), augments it with `timestamp`, `runner`, `commit_sha`, and emits a complete [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) with `predicateType` `https://evals.intentsolutions.io/gate-result/v1`. Optional `--sign` (cosign keyless or `--key`) + `--rekor-url`. OTel `agent.rollout.gate.evaluated` event when `AUDIT_HARNESS_OTEL=1` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **`SEMVER.md`** — explicit SemVer commitment doc covering exit codes, stream contracts, and the predicate-URI freeze.
- **`tests/regression/run-regression.sh`** — backward-compat regression suite (11 checks across text-mode parity, `--json` stream separation, schema validation, and the `emit-evidence` pipeline), wired into a `regression` CI job.

### Changed

- **`bin/audit-harness.js`** dispatcher exposes the new `emit-evidence` subcommand.
- **`scripts/arch-check.sh`** `--json` output reshaped to the gate-result envelope shape.

## [0.2.0] - 2026-05-10

### Added

- **PyPI and crates.io wrappers for audit-harness** (9b97217) — the polyglot trifecta (npm + PyPI + crates) begins here.

### Changed

- **Filled baseline OSS governance gaps via `/repo-dress` (#11).** Completed the `/repo-dress` 21-file canon, including the `release.yml` workflow (#15).
- **Convergence Phase A.0 + A scaffolding** (8f30db4) — bd issue-tracking init, GitHub issue templates, CI workflow, and the three-repo convergence design notes / CLAUDE.md section (b8255a3, ffc7597).
- **Part 2 Workstream A upgrade-landscape docs (#9).**

## [0.1.0] - 2026-04-21

Initial release. Extracted from the `audit-tests` Claude Code skill v7.0.0 to enable in-repo enforcement without global skill installation.

> **Key design decisions:**
>
> - **Scripts stay as shell/python** — not a TypeScript port; battle-tested, language-portable, minimal dependencies.
> - **Thin Node CLI** — `bin/audit-harness.js` is a dispatcher only; all logic lives in `scripts/`.
> - **Policy-driven thresholds** — `escape-scan.sh` reads floors from `tests/TESTING.md` in the target repo, not from the script source.
> - **Zero runtime dependencies** beyond Node 18+, bash, and Python 3 (only if using `crap`).

### Added

- **`audit-harness verify`** — SHA-256 hash verification for pinned policy files.
- **`audit-harness init`** — initialize / re-init the `.harness-hash` manifest.
- **`audit-harness list`** — list pinned files.
- **`audit-harness escape-scan`** — detect AI escape patterns in a diff (coverage-threshold lowering, test deletion, architecture bypasses, test-skip markers).
- **`audit-harness arch`** — dispatch the language-appropriate architecture checker (dependency-cruiser / import-linter / ArchUnit / deptrac / arch-go).
- **`audit-harness bias`** — count common test-bias patterns.
- **`audit-harness gherkin-lint`** — advisory Gherkin quality check.
- **`audit-harness crap`** — CRAP (Complexity × Coverage) scorer for Python, JS/TS, Go, Rust.

[Unreleased]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.3.1...v1.4.0
[1.2.2]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.1.8...v1.2.0
[1.1.8]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.1.7...v1.1.8
[1.1.7]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jeremylongshore/intent-audit-harness/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jeremylongshore/intent-audit-harness/compare/v0.2.0...v1.0.0
[0.3.0]: https://github.com/jeremylongshore/intent-audit-harness/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/jeremylongshore/intent-audit-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeremylongshore/intent-audit-harness/releases/tag/v0.1.0
