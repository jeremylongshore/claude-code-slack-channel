// @ts-check
/**
 * Stryker mutation testing configuration.
 *
 * One-time baseline, manual-run only (not wired into CI).
 * Targets pure-logic modules with dedicated test coverage in server.test.ts.
 *
 * server.ts and supervisor.ts are excluded — they have boot-time side effects
 * and module-load globals that confuse the mutator. journal.ts is excluded
 * from this baseline run to keep the first pass fast (can expand later).
 *
 * Run: bunx stryker run
 * Bead: ccsc-ao9
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
  reporters: ['html', 'clear-text', 'progress'],
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: 60000,
  concurrency: 4,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
