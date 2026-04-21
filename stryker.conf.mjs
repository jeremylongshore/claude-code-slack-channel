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
  // Baseline scope: lib.ts only. A full-scope run over lib.ts + policy.ts +
  // manifest.ts (1427 mutants) projected ~24 min on this hardware — over the
  // 20-min budget this PR's stop-if rule sets. Narrowing to lib.ts gives a
  // meaningful first baseline of the security-critical gate/outbound/sendable
  // guards. policy.ts and manifest.ts can be added in follow-up PRs.
  mutate: ['lib.ts'],
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
