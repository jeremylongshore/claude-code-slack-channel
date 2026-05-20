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
    {
      name: 'no-journal-imports-policy',
      severity: 'error',
      comment:
        'ccsc-22l invariant — journal.ts must not import from policy.ts. The ' +
        '`policy_attestation.digest` field is an opaque 64-char hex string ' +
        'computed by policy.ts:policyDigest() and passed into the journal ' +
        'writer as a primitive. If journal.ts imported policy.ts, the ' +
        'forensic record would become coupled to policy-engine internals ' +
        '— breaking the "journal is the system-of-record" invariant. The ' +
        'reverse direction (policy.ts importing canonicalJson from ' +
        'journal.ts) is permitted: policy needs the same canonicalizer to ' +
        'compute its digest deterministically.',
      from: { path: '^journal\\.ts$' },
      to: { path: '^policy\\.ts$' },
    },
    {
      name: 'no-admin-imports-manifest',
      severity: 'error',
      comment:
        'ccsc-3w0 invariant — admin.ts must not import from manifest.ts. ' +
        'Admin verbs (!clear / !restart) are authoritative operator actions; ' +
        'the manifest module is advertising-only ("advertisements are not ' +
        'grants" — Miller 2006, see 000-docs/bot-manifest-protocol.md). ' +
        'If admin.ts imported manifest.ts, a peer bot that advertises a ' +
        'capability could influence admin dispatch — exactly the bypass the ' +
        '31-A.4 invariant exists to prevent. Same isolation pattern as ' +
        'no-policy-imports-manifest, applied to the admin module.',
      from: { path: '^admin\\.ts$' },
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
