#!/usr/bin/env node
/**
 * audit-harness CLI dispatcher
 *
 * Thin wrapper that invokes the canonical shell/python implementations in scripts/.
 * Keeping the scripts as-is (not a TS port) for v0.x — they're battle-tested
 * and language-portable. The CLI just adds discoverability + cross-platform-ish shell resolution.
 */
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const { existsSync } = require('node:fs');

const SCRIPTS = resolve(__dirname, '..', 'scripts');

const COMMANDS = {
  'verify':        { script: 'harness-hash.sh',  args: ['--verify'] },
  'init':          { script: 'harness-hash.sh',  args: ['--init'] },
  'list':          { script: 'harness-hash.sh',  args: ['--list'] },
  'escape-scan':   { script: 'escape-scan.sh',   args: [] },
  'cred-gate':     { script: 'cred-gate.sh',     args: [] },
  'arch':          { script: 'arch-check.sh',    args: [] },
  'bias':          { script: 'bias-count.sh',    args: [] },
  'gherkin-lint':  { script: 'gherkin-lint.sh',  args: [] },
  'crap':          { script: 'crap-score.py',    args: [] },
  'emit-evidence': { script: 'emit-evidence.sh', args: [] },
  'classify':      { script: 'classify.py',      args: [] },
  'conform':       { script: 'conform.py',       args: [] },
  'audit':         { script: 'audit.py',         args: [] },
  'scan':          { script: 'scan.py',          args: [] },
  'fp-rate':       { script: 'fp-rate.py',       args: [] },
  'currency':      { script: 'currency.py',      args: [] },
  'migration-notes': { script: 'migration-notes.py', args: [] },
  'gen-layer-applicability': { script: 'gen-layer-applicability.py', args: [] },
  'worktree-run':  { script: 'worktree-run.sh',  args: [] },
};

// Gate commands that may be no-op'd by the AUDIT_HARNESS_DISABLE kill-switch.
// classify is intentionally NOT here: it emits a meaningful kill-switched profile
// itself (every gate enforcement=disabled). verify/init/list always run.
const KILLABLE_GATES = new Set([
  'escape-scan', 'cred-gate', 'arch', 'bias', 'gherkin-lint', 'crap', 'emit-evidence',
  'worktree-run',
]);

function usage() {
  console.log(`audit-harness — deterministic test-enforcement toolkit

Usage:
  audit-harness <command> [args...]

Commands:
  verify                   Verify hash-pinned artifacts (exit 2 = HARNESS_TAMPERED)
  init                     Initialize or re-init the .harness-hash manifest
  list                     List currently pinned files
  escape-scan <source>     Scan a diff for escape attempts
                           source: --staged | --range A..B | - (stdin) | path.patch
  cred-gate [args...]      Provider credential PASS/FAIL gate (iah-E08, CISO
                           binding DR-010 S1Q5). Reads a candidate artifact (the
                           JSON about to be signed/emitted) on stdin or --input and
                           FAILs (exit 1) if a declared secret value leaks verbatim,
                           a known provider-key shape is embedded, or the artifact
                           serializes the process environment (env-var spillover).
                           Offline + read-only. --secret-env NAME (repeatable)
                           declares a secret by env-var name; --json emits a
                           gate-result/v1 envelope. See docs/cred-gate.md.
  arch                     Run architecture-rule checks (Wall 7)
  bias                     Count test-bias patterns (tautology, smoke-only, etc.)
  gherkin-lint             Advisory Gherkin quality check
  crap [args...]           CRAP complexity × coverage scorer (multi-language)
  classify [repo]          Read-only repository classifier. Emits an audit-profile/v1
                           value (JSON, stdout) describing the UNION of detected
                           classifications + the resolved gate set. Never writes.
  conform [repo]           Read-only conformance gate-runner. Validates each repo
                           artifact (SKILL.md, .mcp.json, plugin/agent ...) against a
                           content-addressed schema BUNDLED in this harness version
                           and emits gate-result/v1 rows (JSON array, stdout). Never
                           writes, never live-fetches. Advisory by default; --strict
                           turns any conformance violation into FAIL (exit 1).
                           OpenAPI -> spectral, Action -> yamllint (missing tool =
                           INDETERMINATE advisory).
  audit [repo]             Read-only testing-depth gate-runner. For each
                           testing-depth gate in the profile, reports coverage
                           PRESENCE per pyramid layer (unit/integration/e2e/perf/
                           fuzz/...) + runs crap-score. Emits gate-result/v1 rows.
                           --fast (default) presence only; --deep adds crap-score;
                           --strict turns a gap into FAIL. Does NOT execute the
                           repo's test suite — execution stays in the repo's CI.
  scan [repo]              Read-only security/hygiene/skill-quality gate-runner.
                           hygiene-readme is a local presence check; every tool-
                           backed gate (gitleaks/osv-scanner/semgrep/syft/
                           markdownlint/lychee) shells out (clean->PASS, findings->
                           ADVISORY, tool absent->INDETERMINATE); skill-behavioral
                           CONSUMES a j-rig verdict (--jrig-verdict PATH), never
                           reimplementing judgment. Emits gate-result/v1 rows.
                           Advisory by default; --strict turns findings into FAIL.
  fp-rate                  Measure each gate's false-positive / false-negative rate
                           over a labeled corpus (valid/ should be clean, malformed/
                           should flag). The metric that gates advisory->blocking
                           promotion. --max-fp-rate X exits 1 if any gate exceeds X.
                           See docs/gate-promotion.md.
  currency                 Advisory poll-freshness report. Reads the per-upstream
                           pin relation (schemas/currency/pins.v1.json) and flags
                           pins whose checked_at is past their poll-freshness SLA
                           (the SLA gates nothing but human attention). NO exit-code
                           authority (always exit 0), no live-fetch, no auto-fix —
                           it reports; /sync-testing-harness acts.
  migration-notes [ver]    Generate adopter-facing migration notes from CHANGELOG.md
                           + SEMVER.md (iah-E05d). Read-only, deterministic, stdlib.
                           No arg = the latest release; <ver> = one version;
                           --from A --to B = the cumulative notes across (A, B].
                           A MAJOR boundary surfaces the release's Removed/Changed/
                           Deprecated sections + the SEMVER.md breaking-change rules;
                           a minor/patch boundary reports "no action required".
                           --json emits a migration-notes/v1 envelope. Exit 1 =
                           version/range not in CHANGELOG; 2 = CHANGELOG unreadable.
  gen-layer-applicability  Project schemas/audit-profile/registry.v1.json into
                           schemas/audit-profile/layer-applicability.md. --write to
                           regenerate, --check to fail on drift (CI gate). The doc
                           is a PROJECTION of the canonical registry datum.
  emit-evidence            Wrap a gate-result JSON envelope in an in-toto
                           Statement v1 (predicate https://evals.intentsolutions.io/gate-result/v1)
                           Read JSON on stdin: <gate> --json | audit-harness emit-evidence
  worktree-run             Pre-push gate runner: checks the ref being pushed in
                           a disposable git worktree (verify + escape-scan on
                           the push range fail-closed; conform + audit advisory)
                           and emits gate-result/v1 rows. No push authority, no
                           repo writes. --pre-push | --ref REF | --range A..B |
                           --out FILE. Wire via lefthook pre-push (see README).

Evidence Bundle (v0.3.0+):
  All gates support --json to emit machine-readable gate-result envelopes
  suitable for piping to emit-evidence. See SEMVER.md for compatibility rules
  and intent-eval-lab/specs/evidence-bundle/v0.1.0-draft/SPEC.md for the
  envelope schema.

Safety levers:
  AUDIT_HARNESS_DISABLE=1  Kill-switch. Gate commands no-op (exit 0, banner);
                           classify still emits a profile with every gate disabled.
  AUDIT_HARNESS_TIMEOUT=N  Per-command supervision: kill the gate after N seconds
                           (exit 124) so a hung gate never blocks the pipeline.
  .audit-harness.yml       Engineer-owned per-repo override (classify_pins, advisory,
                           disable_gates, disable) honored by classify.

Options:
  --version, -v            Print version
  --help, -h               Print this help

Exit codes (escape-scan):
  0 = clean
  1 = CHALLENGE (engineer-approved comment required)
  2 = REFUSE (pipeline halted)
`);
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '--help' || cmd === '-h') {
  usage();
  process.exit(0);
}

if (cmd === '--version' || cmd === '-v') {
  const pkg = require('../package.json');
  console.log(pkg.version);
  process.exit(0);
}

const entry = COMMANDS[cmd];
if (!entry) {
  console.error(`audit-harness: unknown command '${cmd}'`);
  usage();
  process.exit(2);
}

const scriptPath = resolve(SCRIPTS, entry.script);
if (!existsSync(scriptPath)) {
  console.error(`audit-harness: script not found at ${scriptPath}`);
  process.exit(2);
}

// Kill-switch: gate commands no-op; classify/verify/init/list still run.
if (process.env.AUDIT_HARNESS_DISABLE === '1' && KILLABLE_GATES.has(cmd)) {
  console.error(`audit-harness: KILL-SWITCH active (AUDIT_HARNESS_DISABLE=1) — '${cmd}' skipped`);
  process.exit(0);
}

const isPython = entry.script.endsWith('.py');
const interpreter = isPython ? 'python3' : 'bash';
const finalArgs = [scriptPath, ...entry.args, ...rest];

// Per-command supervision: a hung gate hits its timeout and is killed (exit 124)
// rather than blocking the pipeline. 0/unset = no timeout.
const timeoutSec = Number(process.env.AUDIT_HARNESS_TIMEOUT) || 0;

const child = spawn(interpreter, finalArgs, { stdio: 'inherit' });

let timedOut = false;
let timer = null;
if (timeoutSec > 0) {
  timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2000).unref();
  }, timeoutSec * 1000);
  timer.unref();
}

child.on('exit', (code, signal) => {
  if (timer) clearTimeout(timer);
  if (timedOut) {
    console.error(`audit-harness: ${entry.script} exceeded AUDIT_HARNESS_TIMEOUT=${timeoutSec}s — killed (INDETERMINATE)`);
    process.exit(124);
  }
  if (signal) {
    console.error(`audit-harness: ${entry.script} killed by ${signal}`);
    process.exit(128);
  }
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  if (timer) clearTimeout(timer);
  console.error(`audit-harness: failed to spawn ${interpreter}: ${err.message}`);
  process.exit(2);
});
