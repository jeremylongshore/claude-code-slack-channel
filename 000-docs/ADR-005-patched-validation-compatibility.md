# ADR-005: Patch validation dependencies while preserving application contracts

## Status

Candidate for protected review, 2026-10-25. Paired task: marketplace
`claude-4l09.11`. This decision accompanies the canonical source migration;
it does not approve marketplace intake or the native-bundle candidate in #308.

## Context

The required dependency audit rejects Zod 3.25.76 and nested Zod 4.4.3 under
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The SDK's Express dependency also resolves body-parser 2.2.2, affected by
[GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828).
The published patched versions selected here are Zod 4.6.6 and body-parser
2.4.0. CCSC uses MCP stdio, not an Express HTTP listener; this distinction
does not justify suppressing the dependency audit.

The [Zod migration guide](https://zod.dev/v4/changelog) identifies changes
beyond dependency metadata. Records require explicit key/value schemas,
error issue formats change, and `.int()` adds a safe-integer ceiling.
Unbounded legacy integer fields must not silently acquire that ceiling.

## Decision

1. Adopt the patched Zod 4 API directly. Do not route application imports to
   `zod/v3` or add an audit ignore. Pin the direct version and a compatible
   override to 4.6.6. The existing SDK accepts `^3.25 || ^4.0`, its schema
   converter accepts `^3.25.28 || ^4`, and mutation-server-protocol accepts
   `^4.1.12`. All current paths therefore support the selected major.
2. Pin body-parser to 2.4.0, within Express 5.2.1's existing `^2.2.1`
   dependency range. Accept only the related transitive changes its own
   dependency requirements introduce. Preserve all other dependency floors
   and the existing audit command and exceptions.
3. Express session data as `z.record(z.string(), z.unknown())`. Preserve
   strict session/identity objects and the tolerant, preserving outbox reader
   from the session state-machine contract. No field or on-disk version changes.
4. For the previously unbounded integer fields (journal sequence, policy
   priority, and fetch-message limit), use a numeric schema refined with
   `Number.isInteger` and retain the existing sign/default constraints.
   This preserves Zod 3 acceptance of representable integer-valued numbers,
   including values beyond the safe-integer range. It does not claim those
   values have arbitrary-precision semantics. Tightening those contracts is
   separate work. Existing bounded TTL/quorum integers remain bounded.
5. Keep policy evaluation, signing, canonical serialization, gates, tool
   identities, native configuration and provider behavior unchanged. Do not
   compare Zod's diagnostic issue text as a stable wire contract: issue
   formatting follows the dependency major. Never enable raw-input reporting.

## Evidence and limits

`validation-migration.test.ts` covers nonempty nested session data, future
outbox-field preservation, strict identities, policy defaults, journal bytes,
ACP envelopes, legacy integer acceptance, and bounded collection rejection.
The old-source fixture uses immutable base
`89e93c97da24d8d0814b3619eacec2c6694168e6` with Zod 3.25.76.
The collection control constructs only 64 synthetic invalid tools: the old
version reports 129 issues, whereas the patch rejects the oversized collection
with one issue. This is a bounded regression, not an exhaustion experiment.

These cases and the existing suite are compatibility evidence, not proof over
every possible input. In particular, migration documentation also describes
string-format and diagnostic changes; no universal equivalence or DoD/STIG
compliance claim follows. Required local and hosted gates, frozen installs,
and exact dependency graph review remain release conditions.

The fetch-input schema is shared from `lib.ts` by production and the existing
S5 tests. Its large-integer acceptance case first fails against the stale test
copy, then passes against the shared production schema; fraction and zero
rejection cases continue to pass. This removes that duplicated boundary
instead of making another test copy agree with the implementation.

## Rollback

Revert the focused migration through a reviewed PR, restoring its source and
lock together. The known advisory failures would return and remain visible;
rollback must not add ignores or weaken the audit. No history rewrite,
registry mutation, credential operation or source-sync waiver is involved.
