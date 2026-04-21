# `features/` — Acceptance-level contracts

These `.feature` files are the acceptance-level contracts for the
four-principal security model. They describe, in declarative business
language, what each security primitive promises to do on the boundary
between Claude, the Slack workspace, the operator's disk, and peer
bots.

## Primitives covered

| File | Primitive | Source |
|---|---|---|
| `inbound_gate.feature` | `gate()` | `lib.ts` |
| `file_exfiltration_guard.feature` | `assertSendable()` | `lib.ts` |
| `outbound_reply_filter.feature` | `assertOutboundAllowed()` | `lib.ts` |
| `policy_evaluation.feature` | `evaluate()` | `policy.ts` |
| `audit_chain_verifier.feature` | `verifyJournal()` | `journal.ts` |

## Ownership rule (engineer-owned)

Per the `/audit-tests` skill's Wall 1 rule, these scenarios are
engineer-owned. AI tooling may add step definitions, wire runners, or
refactor adjacent glue code. AI tooling **must not** edit the scenarios
themselves — a byte-level change to any `.feature` file will fail
`harness-hash.sh --verify` and `escape-scan.sh` will refuse the diff.

To update a scenario:

1. An engineer edits the `.feature` file.
2. An engineer runs `bash scripts/harness-hash.sh --init` to regenerate
   the manifest.
3. The updated `.feature` file and the new `.harness-hash` land in the
   same commit.

## Runner status — lint-only today

There is no executing runner wired up. The CI gate is lint-only:

```bash
bash scripts/gherkin-lint.sh --path features/ --strict
```

This enforces declarative style (no imperative verbs, no CSS
selectors), scenario length (≤10 steps), and structural rules (no
scenario may start with `And`, a `Background` block is required when
a `Given` repeats 3+ times).

Wiring a runner that executes the scenarios against real step
definitions is tracked by a deferred bd filed alongside this scaffold
(see `000-docs/TEST_AUDIT.md` → "Post-audit follow-up").

## Pinning (tamper guard)

The manifest at `.harness-hash` pins every `.feature` file here, plus
the architecture rule configs and coverage thresholds. The tamper
guard runs in CI:

```bash
bash scripts/harness-hash.sh --verify
```

If the verifier reports `HARNESS_TAMPERED`, the PR is refused until
the manifest is re-generated via `--init` and committed alongside the
content change.
