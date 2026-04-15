<!--
Thanks for the PR! A few quick notes before you hit submit:

- Keep the diff focused. One idea per PR beats one big dump.
- If you touched anything in the "Security impact" section below, expect extra
  scrutiny — that's a feature, not friction.
- Not sure whether something counts as security-sensitive? Check the boxes
  anyway. Over-flagging is fine. Under-flagging is not.
-->

## What

<!-- One or two sentences. What does this change do, from a user's perspective? -->

## Why

<!-- The motivation. Link the issue or discussion if there is one: "Fixes #123". -->

## How

<!-- Brief walkthrough of the approach. Call out anything non-obvious,
     any tradeoffs, anything a reviewer would miss on a skim. -->

---

## Security impact

Check every box that applies. If any of these are checked, the PR description
**must** explain the threat-model reasoning — not just "tests pass."

- [ ] Touches `gate()` / inbound gating logic in `lib.ts`
- [ ] Touches `assertSendable()` / file exfiltration guard
- [ ] Touches `assertOutboundAllowed()` / outbound gating logic
- [ ] Changes the Socket Mode / MCP stdio transport in `server.ts`
- [ ] Adds, removes, or modifies an MCP tool exposed to Claude
- [ ] Touches token loading, `.env` handling, or `access.json` I/O
- [ ] Changes the system-prompt hardening text
- [ ] Adds a new runtime dependency (anything landing in `package.json`)
- [ ] None of the above — this is a docs / test-only / cosmetic change

<!-- If you checked anything above, answer these: -->
<!-- - What's the new trust boundary (if any)? -->
<!-- - What can an attacker-controlled message do after this change that it couldn't before? -->
<!-- - What existing defense layer catches this if your new code has a bug? -->

---

## Test evidence

Pick the tier that matches your change. One tier is enough — pick the strongest
one that genuinely applies. Don't claim a tier you didn't meet.

### Tier A — Automated test in the suite

- [ ] I added or updated tests in `server.test.ts` (or a new `*.test.ts` file)
- [ ] `bun test` passes locally
- [ ] `bun run typecheck` passes locally
- [ ] The test would fail without my fix (I verified by reverting the fix)

<!-- Paste the relevant test name(s) or a short excerpt of the new assertion. -->

### Tier B — Reproducible script CI can run

Use this when the behavior is hard to unit-test (real Slack event shapes,
real MCP handshake, file-system edge cases) but can still be exercised
deterministically from a script.

- [ ] Script lives at `scripts/<name>.ts` (or is inlined in the PR body)
- [ ] Script is runnable with `bun run scripts/<name>.ts` with no secrets
- [ ] Script exits non-zero on failure
- [ ] Expected output is pasted below, verbatim

<!-- ```
$ bun run scripts/repro.ts
... expected output ...
``` -->

### Tier C — Human evidence you ran yourself

Use this only when the behavior truly cannot be automated (signals,
real Slack handshakes, zombie-process checks). **You** run it, **you** post
the evidence. The maintainer will not re-run it — if your evidence isn't
convincing, you'll be asked for more, or the PR will be declined.

- [ ] Exact command(s) you ran, copy-pasteable
- [ ] Your actual terminal output pasted below (or a screen recording attached)
- [ ] Environment: OS, Bun version, Claude Code version
- [ ] Any required setup (tokens, workspace, channel) called out

<!-- 1. ...
     2. ...
     3. Observed: ... -->

---

## Checklist

- [ ] I read `CLAUDE.md` and `SECURITY.md` and the change is consistent with them
- [ ] Pure logic went into `lib.ts`; stateful wiring stayed in `server.ts`
- [ ] I did not add runtime dependencies beyond what's needed (the "four deps" rule)
- [ ] Commit messages describe *why*, not just *what*
- [ ] If this is a breaking change, `CHANGELOG.md` says so loudly
