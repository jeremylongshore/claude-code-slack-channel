// dependency-cruiser configuration.
//
// Purpose: formally encode Epic 31-A.4 architecture invariant as a machine-
// verifiable import-graph rule, alongside the existing regex-based test in
// server.test.ts (belt-and-suspenders).
//
// The invariant (from 000-docs/bot-manifest-protocol.md §91-109,
// "The binding invariant" — "advertisements are not grants"):
//
//   policy.ts must NEVER import from manifest.ts.
//
// The bot-manifest module is advertising-only. The policy engine is
// authoritative. If policy.ts ever imports manifest.ts, an adversary who
// advertises a capability gains an implicit grant — which violates the
// fundamental "advertisements are not grants" contract. Any such import
// is a merge block, not a warning.
//
// Paired guards:
//   - server.test.ts "31-A.4 invariant" (regex parse of policy.ts imports)
//   - .dependency-cruiser.js (this file — import-graph rule, CI-enforced)

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-policy-imports-manifest',
      severity: 'error',
      comment:
        'Epic 31-A.4 invariant — policy.ts must not import from manifest.ts. ' +
        'The bot-manifest module is advertising-only; the policy engine is ' +
        'authoritative. See 000-docs/bot-manifest-protocol.md §91-109 ' +
        '("advertisements are not grants").',
      from: { path: '^policy\\.ts$' },
      to: { path: '^manifest\\.ts$' },
    },
  ],
  options: {
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    includeOnly: '^[^/]+\\.ts$',
  },
}
