// @ts-check
/**
 * Stryker mutation testing configuration.
 *
 * Gated in CI via the scheduled/dispatch `Mutation` workflow
 * (.github/workflows/mutation.yml) — NOT the per-PR `ci.yml` job, since a full
 * run is ~42 min. `thresholds.break = 80` makes Stryker exit non-zero (failing
 * that workflow) if the overall mutation score drops below 80%, ~5pp under the
 * documented 85.22% baseline (000-docs/MUTATION_REPORT.md). Wired by ccsc-0mn.
 *
 * Targets the four security-critical pure-logic modules. server.ts and
 * supervisor.ts are excluded — they have boot-time side effects and module-load
 * globals that confuse the mutator (supervisor mutants also time out under the
 * command runner's cold-spawn overhead).
 *
 * Run locally: bunx stryker run
 * Beads: ccsc-ao9 (baseline), ccsc-l5z (expanded scope), ccsc-0mn (CI gate)
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // Expanded scope (ccsc-l5z): lib.ts + policy.ts + manifest.ts + journal.ts.
  // Baseline runs now cover the four security-critical modules. server.ts and
  // supervisor.ts remain out of scope — server.ts has boot-time side effects
  // and module-load globals; supervisor.ts is well-covered by integration-
  // style tests but its mutants regularly time out under the command runner's
  // cold-spawn overhead. Per-file mutation scores are captured in
  // 000-docs/MUTATION_REPORT.md after each run.
  mutate: ['lib.ts', 'policy.ts', 'manifest.ts', 'journal.ts'],
  testRunner: 'command',
  commandRunner: {
    command: 'bun test --timeout 15000',
  },
  // TS checker disabled: tsconfig.json 'include' limits files to
  // [server.ts, lib.ts, server.test.ts], so the checker refuses to watch
  // manifest.ts and policy.ts ("no watcher is registered"). We deliberately
  // do not expand tsconfig here — it would pull untested files into every
  // `bun run typecheck`. Without the checker, mutants that produce type
  // errors run anyway and are killed by the test suite instead.
  checkers: [],
  coverageAnalysis: 'off',
  // `json` emits a compact machine-readable reports/mutation/mutation.json
  // (the `html` report embeds the full viewer bundle → ~230 MB, which OOMs
  // small boxes on parse). The json report is the survivor source of truth:
  // the Mutation workflow uploads reports/mutation/, so survivors can be
  // extracted per-file without re-running Stryker locally (ccsc-2et).
  reporters: ['html', 'json', 'clear-text', 'progress'],
  // break: 80 — fail the run if overall mutation score drops below 80%.
  // Documented baseline is 85.22% (000-docs/MUTATION_REPORT.md, ccsc-y4e);
  // 80 sits ~5pp below baseline, the regression margin called for in ccsc-0mn.
  // Enforced by the scheduled/dispatch `Mutation` workflow
  // (.github/workflows/mutation.yml), NOT the per-PR `ci.yml` job — a full run
  // is ~42 min and would triple PR CI cost (the original ccsc-0mn blocker).
  // Lower this only alongside a documented baseline re-measure.
  thresholds: { high: 80, low: 60, break: 80 },
  timeoutMS: 60000,
  concurrency: 4,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
