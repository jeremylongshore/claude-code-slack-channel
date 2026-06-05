# Contributing to CCSC

Thanks for considering a contribution. CCSC is opinionated about how work
lands; this doc captures the conventions so your PR doesn't bounce off them.

## Before you start

- Read [`README.md`](README.md) to understand what this repo is and how to install it.
- **Read [`ROADMAP.md`](ROADMAP.md) — especially the [Non-Goals](ROADMAP.md#non-goals)
  section — *before* writing any code.** CCSC has a deliberately narrow charter.
  Some otherwise-good work (e.g. multi-process / multi-session orchestration) is
  out of scope here by design and belongs in the companion
  [agent-governance-plane](https://github.com/jeremylongshore/agent-governance-plane).
  A PR that implements a non-goal will be closed with a pointer back to the
  roadmap — that's not a judgment of the work, just of the fit.
- Read [`AGENTS.md`](AGENTS.md) if you're using an AI assistant — it has the
  load-bearing context every agent needs (module layout, architecture
  invariants, what NOT to do).

### Open an issue before a substantial PR

This is keyed on **scope, not on who you are** — it applies to everyone:

- **Small fixes** (a typo, a one-line bug, a doc clarification) — just open the PR.
- **Anything larger** — **open a GitHub issue first** describing the problem and
  your proposed approach, and confirm it's on-roadmap, *before* you invest in
  code. Solo author with a busy schedule: a 5-line issue saves a 500-line PR
  from being closed unread.
- **Large or architectural PRs opened with no prior discussion may be closed**
  unmerged, regardless of quality. This isn't gatekeeping — it's the only way a
  solo maintainer can keep the project pointed in one direction. A first
  contribution is best made *small* (one focused fix), not as a sweeping change.
- **Complete the PR template.** A PR with an empty description, or with the
  **Security impact** section left blank when it touches anything security-
  sensitive, will be asked to fill it in before any review happens. "Tests pass"
  is not a description.

## Dev environment

Prerequisites are in [`README.md` § Prerequisites](README.md#prerequisites):
Bun ≥ 1.0, Claude Code ≥ v2.1.80, `claude.ai` login.

```bash
git clone https://github.com/jeremylongshore/claude-code-slack-channel.git
cd claude-code-slack-channel
bun install
bun run typecheck   # sanity check
bun test            # 986+ tests should pass green
```

If you want to run the MCP server against a real Slack workspace while
developing, follow [`skills/install/SKILL.md`](skills/install/SKILL.md) (or
run `/slack-channel:install`) — that sets up a test app, tokens, and
pairing without you having to assemble steps from five different files.

Dev mode bypasses the plugin allowlist:

```bash
claude --dangerously-load-development-channels server:slack
```

## Branching + commits

- **Feature branches always. Never push to `main` directly.**
- Branch naming:
  - `feat/<description>-bz-<bead-id>` for new features
  - `fix/<description>-bz-<bead-id>` for bug fixes
  - `docs/<description>-bz-<bead-id>` for documentation-only changes
- One logical change per commit. Don't bundle "refactor + fix + feature"
  in one commit — split into three.
- Commit messages: imperative present tense ("add streaming reply", not
  "added streaming reply"). Keep the subject under 70 chars.
- **Do NOT add `Co-Authored-By`, AI-marketing strings, or model-version
  tags to commit messages.** Repo convention.

## Pull requests

- **Title**: short, under 70 chars. Describes the outcome, not the
  mechanism. ("Add streaming reply for long Claude outputs", not
  "Refactor reply tool to use chat.update").
- **Body** must include:
  - **Summary** — 1–3 bullets on what changed and why.
  - **Test plan** — markdown checklist of what you verified.
  - **Closes <bead-id>** — reference the bead this ships (if applicable).
- One PR = one logical unit. Don't bundle unrelated changes.
- **Gemini auto-reviews PRs** via the GitHub App. Round-1 findings are
  usually legitimate — address them in fix-up commits, NOT by force-push.
  See `~/.claude/CLAUDE.md` § "Autonomous git on feature branches" for
  the canonical Gemini-review loop.
- **Required CI**: `Typecheck` (the 9-gate sweep), `gitleaks`, `CodeQL`,
  `Scorecard`. All must be green before merge.
- **Branch protection**: `Typecheck` is the required status check with
  `strict: true` (PR must be up-to-date with `main`).

## Quality gates (run before pushing)

These are the gates CI will run. If any fail locally, the PR will fail
in CI too — save yourself the round-trip:

```bash
bun run typecheck                                    # TypeScript strict
bunx @biomejs/biome check .                          # Lint
bun test --timeout 15000                             # 986+ tests pass
bash scripts/coverage-floor.sh 95                    # 95% line + func coverage
bun scripts/crap-score.ts --threshold 30             # Per-function complexity
bunx depcruise --config .dependency-cruiser.js .     # Architecture rules
bash scripts/gherkin-lint.sh --path features/ --strict
bash scripts/harness-hash.sh --verify                # Tamper check
bun audit --audit-level=high --ignore=GHSA-j3q9-mxjg-w52f
```

Optional but appreciated for non-trivial logic changes:

```bash
bunx stryker run    # Mutation testing (~45 min) — see 000-docs/MUTATION_REPORT.md
```

## Architecture invariants you must NOT break

These are enforced by `.dependency-cruiser.js` and will fail CI:

- `server.ts` MUST NOT import `manifest.ts` (31-A.4 invariant).
- `journal.ts` MUST NOT import `policy.ts` (no-journal-imports-policy).
- `admin.ts` MUST NOT import `manifest.ts` (no-admin-imports-manifest).

If your change forces an invariant to be broken, that's a design discussion
on the GitHub issue first — not a PR submission.

## Where to put new code

- **Pure logic** → a sibling module (the 17 existing sibling modules are the
  pattern: `lib.ts`, `journal.ts`, `policy.ts`, `manifest.ts`, etc.). Keep
  them side-effect-free where possible; accept dependencies as parameters.
- **Stateful runtime concerns** → `server.ts`. Slack client bootstrap,
  MCP server registration, event listeners, file I/O.
- **Tests**:
  - Unit + integration → `server.test.ts`
  - Gherkin acceptance contracts → `features/*.feature` + matching steps
    in `features/steps/`
- **Operator CLIs** → `scripts/` (e.g., `scripts/audit-key.ts`).

## Security-sensitive changes

Changes to these functions are security-critical and need extra scrutiny:

| File | Functions / surface |
|---|---|
| `lib.ts` | `gate()`, `assertOutboundAllowed()`, `assertSendable()` |
| `journal.ts` | Hash chain, redactor, `verifyJournal` |
| `crypto.ts` | Ed25519 signing |
| `admin.ts` | All admin command routing |
| `audit-key-loader.ts` | Boot-time key load + SOPS decryption |
| `policy.ts` | `evaluate()`, shadow linter, monotonicity check |

If you're touching any of these, **read the matching design doc in
`000-docs/` FIRST**. A PR that contradicts a frozen design doc is a
revert, not a merge. The design-in-public commitment: docs ship before
code, and docs are the source of truth for security-boundary decisions.

## Issue tracking (beads / bd)

This repo uses [bd (beads)](https://github.com/gastownhall/beads) for issue
tracking. If you're an external contributor, you don't need to use bd —
file a GitHub issue and the maintainer will mirror it into a bead. If
you're working from a bead, reference its ID in commits and PRs
(`Closes ccsc-xyz` in the PR body).

## Reporting security vulnerabilities

**DO NOT file a public GitHub issue for security vulnerabilities.** See
[`SECURITY.md`](SECURITY.md) for the disclosure policy. Short version:
email jeremy@intentsolutions.io with details.

## Code of conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Be decent. No harassment,
no discriminatory language, no spam PRs.

## License

By contributing, you agree your contributions are licensed under the
Apache License 2.0 (see [`LICENSE`](LICENSE)).
