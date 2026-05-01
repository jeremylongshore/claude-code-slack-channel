# audit-harness test baseline — 2026-05-01

**Program**: VPS-as-the-home (`OPS-5nm`), Priority 6 (`OPS-z9b`) — fan-out batch
**Pilot reference**: hybrid-ai-stack PR #4 (the canonical pattern)

## What got installed

| Artifact | Location |
|---|---|
| `@intentsolutions/audit-harness v0.1.0` (vendored) | `.audit-harness/` |
| Wrapper | `scripts/audit-harness` |

Install command:
```bash
curl -sSL https://raw.githubusercontent.com/jeremylongshore/audit-harness/main/install.sh | bash
```

## Why vendored (and not `bun add` / `npm install`)

This repo uses Bun. The harness is published on npm as `@intentsolutions/audit-harness` and would install fine via `bun add -D`, but the IS Testing SOP standardizes on **vendored** for repos managed outside the typical Node ecosystem — keeps the install command identical across Python / Rust / Bun / etc. and makes hooks portable. We can switch to `bun add` later if it proves a better fit.

## Deferred to subsequent sessions

- `/audit-tests` skill run → `TEST_AUDIT.md`
- `tests/TESTING.md` policy authorship (coverage / mutation / CRAP thresholds)
- Pre-commit hook + CI wiring for `scripts/audit-harness escape-scan --staged`

## Cross-references

- Program plan: `~/000-projects/intentsolutions-vps-runbook/plans/2026-05-01-vps-as-the-home/00-plan.md` § Priority 6
- Repo baseline tracker: `~/000-projects/intentsolutions-vps-runbook/docs/repo-baseline-tracker.md`
- IS Testing SOP: `~/000-projects/CLAUDE.md` + `~/.claude/CLAUDE.md`
- Bead: `OPS-z9b`
- Pilot: `~/000-projects/hybrid-ai-stack/01-Docs/021-ref-audit-harness-test-baseline-2026-05-01.md`
