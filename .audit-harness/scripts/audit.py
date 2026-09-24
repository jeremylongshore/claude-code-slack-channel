#!/usr/bin/env python3
"""
audit-harness audit — read-only testing-depth gate-runner (PP-PLAN-040 Phase 3 / E5).

For every `dimension: testing-depth` gate in a repo's audit-profile/v1, audit
assesses the gate and emits a `gate-result/v1` row (JSON array, stdout). It is the
"finish the pyramid" diagnostic: it reports which testing-depth LAYERS a repo has
infrastructure for, advisory-first.

Two assessment strategies, both read-only:
  - crap-score    -> runs the bundled `crap` scorer (static complexity x coverage).
  - presence      -> a per-layer static heuristic (test dirs, framework configs,
                     dependency markers). Layer infra present -> PASS; absent ->
                     ADVISORY(warn) "testing-depth gap"; unknowable statically ->
                     ADVISORY indeterminate.

What audit deliberately does NOT do: execute the repo's test suite. Running
arbitrary, untrusted test suites is the job of the repo's own CI test step — the
harness wraps that step's verdict into Evidence, it does not replace it. audit
reports COVERAGE PRESENCE; execution stays in CI. Each row records its
`metadata.method` so the assessment provenance is explicit.

--fast (default): presence heuristics only (<10s on a reference repo).
--deep:           presence + crap-score.
--strict:         a testing-depth gap on an `enforcement: blocking` gate -> FAIL.

Stdlib only. No network. No filesystem mutation.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import classify as C  # noqa: E402

EMPTY_SHA = "sha256:" + hashlib.sha256(b"").hexdigest()

SKIP_DIRS = ("node_modules", ".git", ".venv", "dist", "build", "vendor", "target")

# Gates assessed quickly (presence heuristics) belong to the fast tier; crap-score
# is deep-only because it shells out to radon/gocyclo and can be slow.
DEEP_ONLY = {"crap-score"}


def sha256_str(s):
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# repo signal collectors
# --------------------------------------------------------------------------- #
def collect_node_deps(repo):
    deps = {}
    for pkgpath in [os.path.join(repo, "package.json")] + [
        os.path.join(s, "package.json") for s in C.list_pkg_subdirs(repo)
    ]:
        pkg = C.read_json(pkgpath)
        if isinstance(pkg, dict):
            for k in ("dependencies", "devDependencies"):
                if isinstance(pkg.get(k), dict):
                    deps.update(pkg[k])
    return deps


def node_test_script(repo):
    pkg = C.read_json(os.path.join(repo, "package.json")) or {}
    scripts = pkg.get("scripts") if isinstance(pkg, dict) else None
    return isinstance(scripts, dict) and bool(scripts.get("test"))


def py_dep_text(repo):
    txt = ""
    for f in ("requirements.txt", "pyproject.toml", "Pipfile", "setup.cfg", "tox.ini"):
        p = os.path.join(repo, f)
        if os.path.isfile(p):
            try:
                txt += open(p, "r", encoding="utf-8").read().lower()
            except Exception:
                pass
    return txt


def walk_names(repo, max_depth=4):
    """Yield (dirpath_rel, dirnames, filenames) skipping vendor/build dirs."""
    repo = os.path.abspath(repo)
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        depth = root[len(repo):].count(os.sep)
        if depth > max_depth:
            dirs[:] = []
            continue
        yield root, dirs, files


def has_dir(repo, *names):
    targets = set(names)
    for _root, dirs, _files in walk_names(repo):
        if targets & set(dirs):
            return True
    return False


def has_file_matching(repo, predicate):
    for _root, _dirs, files in walk_names(repo):
        if any(predicate(f) for f in files):
            return True
    return False


def has_glob_suffix(repo, *suffixes):
    return has_file_matching(repo, lambda f: any(f.endswith(s) for s in suffixes))


# --------------------------------------------------------------------------- #
# per-layer presence detectors -> (present: bool|None, signal: str)
#   present True  -> infra detected (PASS)
#   present False -> no infra detected (ADVISORY gap)
#   present None  -> not assessable statically (ADVISORY indeterminate)
# --------------------------------------------------------------------------- #
def d_unit(repo, deps):
    if node_test_script(repo):
        return True, "package.json scripts.test"
    if any(x in deps for x in ("vitest", "jest", "mocha", "ava", "@jest/core", "node:test")):
        return True, "node test framework dep"
    txt = py_dep_text(repo)
    if any(x in txt for x in ("pytest", "unittest", "nose")):
        return True, "python test framework"
    if has_glob_suffix(repo, "_test.go"):
        return True, "go *_test.go"
    if has_dir(repo, "tests", "test", "__tests__") or \
       has_glob_suffix(repo, ".test.ts", ".test.js", ".spec.ts", ".spec.js"):
        return True, "test dir / *.test|spec file"
    if has_file_matching(repo, lambda f: f.startswith("test_") and f.endswith(".py")):
        return True, "python test_*.py"
    return False, "no unit test infrastructure detected"


def d_integration(repo, deps):
    if has_dir(repo, "integration") or \
       has_glob_suffix(repo, ".integration.test.ts", ".integration.test.js", ".int.test.ts"):
        return True, "integration test dir/files"
    if any(x in deps for x in ("testcontainers", "supertest")):
        return True, "integration tooling dep"
    if "tests/integration" in py_dep_text(repo):
        return True, "python integration tests"
    return False, "no integration test infrastructure detected"


def d_e2e(repo, deps):
    if any(x in deps for x in ("@playwright/test", "playwright", "cypress", "puppeteer", "@testing-library/react")):
        return True, "e2e framework dep"
    cfgs = ("playwright.config.ts", "cypress.config.ts", "cypress.config.js")
    if has_dir(repo, "e2e") or any(os.path.isfile(os.path.join(repo, c)) for c in cfgs):
        return True, "e2e config/dir"
    return False, "no e2e test infrastructure detected"


def d_smoke(repo, deps):
    pkg = C.read_json(os.path.join(repo, "package.json")) or {}
    scripts = pkg.get("scripts") if isinstance(pkg, dict) else {}
    if isinstance(scripts, dict) and any("smoke" in k for k in scripts):
        return True, "package.json smoke script"
    if has_dir(repo, "smoke") or has_file_matching(repo, lambda f: "smoke" in f.lower()):
        return True, "smoke test dir/file"
    return False, "no smoke test detected"


def d_perf(repo, deps):
    if any(x in deps for x in ("benchmark", "tinybench", "vitest-bench", "k6", "autocannon")):
        return True, "perf/bench dep"
    if has_dir(repo, "bench", "benchmark", "benchmarks", "perf") or \
       has_glob_suffix(repo, ".bench.ts", ".bench.js", "_bench.go"):
        return True, "bench dir/files"
    return False, "no performance test infrastructure detected"


def d_a11y(repo, deps):
    if any(x in deps for x in ("axe-core", "@axe-core/playwright", "jest-axe", "pa11y")):
        return True, "a11y tooling dep"
    # Accessibility is not a web-only layer. QML, native, CLI/TUI, mobile, and
    # desktop projects commonly assert roles, names, focus, keyboard routing,
    # contrast, or screen-reader contracts in ordinary language-native tests.
    # Keep the filename signal test-specific so an accessibility.md design
    # document alone does not masquerade as executable evidence.
    if has_dir(repo, "a11y", "accessibility"):
        return True, "a11y/accessibility test dir"
    test_exts = (".js", ".ts", ".py", ".go", ".rs", ".java", ".kt", ".cs", ".rb")
    if has_file_matching(
        repo,
        lambda f: ("a11y" in f.lower() or "accessibility" in f.lower())
        and ("test" in f.lower() or "spec" in f.lower())
        and f.lower().endswith(test_exts),
    ):
        return True, "a11y/accessibility test file"
    return False, "no accessibility test infrastructure detected"


def d_contract(repo, deps):
    if any(x in deps for x in ("@pact-foundation/pact", "pact")):
        return True, "contract testing dep (pact)"
    if has_dir(repo, "contract", "contracts", "pacts"):
        return True, "contract test dir"
    return False, "no contract test infrastructure detected"


def d_migration(repo, deps):
    if has_dir(repo, "migrations", "migration"):
        return True, "migrations dir"
    if any(x in deps for x in ("prisma", "knex", "typeorm", "drizzle-kit")):
        return True, "migration tooling dep"
    if any(x in py_dep_text(repo) for x in ("alembic", "django")):
        return True, "python migration tooling"
    return False, "no migration test infrastructure detected"


def d_property(repo, deps):
    if any(x in deps for x in ("fast-check", "jsverify")):
        return True, "property-based dep (fast-check)"
    if any(x in py_dep_text(repo) for x in ("hypothesis",)):
        return True, "python hypothesis"
    if "proptest" in py_dep_text(repo) or has_glob_suffix(repo, "_proptest.rs"):
        return True, "rust proptest"
    return False, "no property-based test infrastructure detected"


def d_fuzz(repo, deps):
    if has_dir(repo, "fuzz") or has_glob_suffix(repo, "_fuzz.go", "fuzz_target.rs"):
        return True, "fuzz dir/targets"
    if any(x in deps for x in ("@jazzer.js/core", "jazzer")) or "atheris" in py_dep_text(repo):
        return True, "fuzz tooling dep"
    return False, "no fuzz test infrastructure detected"


def d_sanitizers(repo, deps):
    for f in ("Makefile", "CMakeLists.txt"):
        p = os.path.join(repo, f)
        if os.path.isfile(p):
            try:
                if "-fsanitize" in open(p, "r", encoding="utf-8").read():
                    return True, "-fsanitize in build config"
            except Exception:
                pass
    return False, "no sanitizer configuration detected"


DETECTORS = {
    "unit": d_unit, "integration": d_integration, "e2e": d_e2e, "smoke": d_smoke,
    "perf": d_perf, "a11y": d_a11y, "contract": d_contract, "migration": d_migration,
    "property-based": d_property, "fuzz": d_fuzz, "sanitizers": d_sanitizers,
}


# --------------------------------------------------------------------------- #
def make_row(gate_id, result, *, policy_hash, input_hash, commit_sha, runner,
             metadata=None, failure_mode=None, advisory_severity=None):
    row = {
        "gate_id": gate_id, "result": result, "policy_hash": policy_hash,
        "input_hash": input_hash,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runner": runner, "commit_sha": commit_sha,
    }
    if metadata:
        row["metadata"] = metadata
    if failure_mode is not None:
        row["failure_mode"] = failure_mode
    if advisory_severity is not None:
        row["advisory_severity"] = advisory_severity
    return row


def gate_suffix(gate_id):
    return gate_id.rsplit(":", 1)[-1]


def run_crap(repo, gate, commit_sha, runner, strict):
    enforcement = gate.get("enforcement", "advisory")
    try:
        proc = subprocess.run([sys.executable, os.path.join(HERE, "crap-score.py")],
                              cwd=repo, capture_output=True, text=True, timeout=120)
        ok = proc.returncode == 0
        detail = (proc.stdout or proc.stderr).strip().splitlines()[-1:] if (proc.stdout or proc.stderr) else []
    except Exception as e:
        return make_row(gate["gate_id"], "ADVISORY", policy_hash=sha256_str("crap:default"),
                        input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                        advisory_severity="warn",
                        metadata={"method": "crap-static", "indeterminate": True, "reason": str(e)})
    if ok:
        return make_row(gate["gate_id"], "PASS", policy_hash=sha256_str("crap:default"),
                        input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                        metadata={"method": "crap-static", "detail": detail})
    result, fm, sev = ("FAIL", "testing-depth:crap-threshold", None) if (strict or enforcement == "blocking") \
        else ("ADVISORY", None, "error")
    return make_row(gate["gate_id"], result, policy_hash=sha256_str("crap:default"),
                    input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                    failure_mode=fm, advisory_severity=sev,
                    metadata={"method": "crap-static", "detail": detail})


def run_presence(suffix, repo, deps, gate, commit_sha, runner, strict):
    enforcement = gate.get("enforcement", "advisory")
    present, signal = DETECTORS[suffix](repo, deps)
    if present is True:
        return make_row(gate["gate_id"], "PASS", policy_hash=sha256_str(f"presence:{suffix}"),
                        input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                        metadata={"method": "presence-heuristic", "layer": suffix, "signal": signal})
    if present is None:
        return make_row(gate["gate_id"], "ADVISORY", policy_hash=sha256_str(f"presence:{suffix}"),
                        input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                        advisory_severity="warn",
                        metadata={"method": "presence-heuristic", "layer": suffix,
                                  "indeterminate": True, "reason": signal})
    # gap
    result, fm, sev = ("FAIL", f"testing-depth:{suffix}-gap", None) if (strict or enforcement == "blocking") \
        else ("ADVISORY", None, "warn")
    return make_row(gate["gate_id"], result, policy_hash=sha256_str(f"presence:{suffix}"),
                    input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                    failure_mode=fm, advisory_severity=sev,
                    metadata={"method": "presence-heuristic", "layer": suffix, "reason": signal})


def compute_profile(repo, registry_path, profile_arg):
    if profile_arg == "-":
        return json.load(sys.stdin)
    if profile_arg:
        with open(profile_arg, "r", encoding="utf-8") as f:
            return json.load(f)
    out = subprocess.run([sys.executable, os.path.join(HERE, "classify.py"), repo,
                          "--registry", registry_path], capture_output=True, text=True)
    if out.returncode != 0:
        sys.stderr.write(out.stderr)
        raise SystemExit(2)
    return json.loads(out.stdout)


def main():
    ap = argparse.ArgumentParser(description="Read-only testing-depth gate-runner -> gate-result/v1 rows")
    ap.add_argument("repo", nargs="?", default=".")
    ap.add_argument("--fast", action="store_true", help="presence heuristics only (default tier)")
    ap.add_argument("--deep", action="store_true", help="presence + crap-score")
    ap.add_argument("--strict", action="store_true", help="treat a testing-depth gap as FAIL (exit 1)")
    ap.add_argument("--registry", default=C.DEFAULT_REGISTRY)
    ap.add_argument("--profile", default=None, help="pinned audit-profile/v1 (PATH or '-')")
    args = ap.parse_args()

    deep = args.deep and not args.fast
    repo = os.path.abspath(args.repo)
    runner = f"audit-harness@{C.harness_version()}"

    override_path = os.path.join(repo, ".audit-harness.yml")
    override = C.parse_override(override_path) if os.path.isfile(override_path) else {"disable": False}
    if override.get("disable") or os.environ.get("AUDIT_HARNESS_DISABLE") == "1":
        sys.stderr.write("audit-harness: KILL-SWITCH active — audit skipped (no rows emitted)\n")
        print("[]")
        sys.exit(0)

    profile = compute_profile(repo, os.path.abspath(args.registry), args.profile)
    commit_sha = profile.get("subject", {}).get("commit_sha") or C.git_short_sha(repo)
    deps = collect_node_deps(repo)

    gates = [g for g in profile.get("gates", [])
             if g.get("dimension") == "testing-depth" and g.get("enforcement") != "disabled"]

    rows = []
    for gate in gates:
        suffix = gate_suffix(gate["gate_id"])
        if suffix == "crap-score":
            if not deep:
                rows.append(make_row(gate["gate_id"], "ADVISORY", policy_hash=sha256_str("crap:default"),
                                     input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                                     advisory_severity="info",
                                     metadata={"method": "crap-static", "skipped": "deep-only (run with --deep)"}))
            else:
                rows.append(run_crap(repo, gate, commit_sha, runner, args.strict))
        elif suffix in DETECTORS:
            rows.append(run_presence(suffix, repo, deps, gate, commit_sha, runner, args.strict))
        else:
            # e.g. per-package-classify — assessment delegated, not a static signal
            rows.append(make_row(gate["gate_id"], "ADVISORY", policy_hash=sha256_str(f"audit:{suffix}"),
                                 input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                                 advisory_severity="info",
                                 metadata={"method": "delegated", "indeterminate": True,
                                           "reason": f"'{suffix}' has no static testing-depth heuristic "
                                                     f"in this harness version"}))

    print(json.dumps(rows, indent=2))
    n_fail = sum(1 for r in rows if r["result"] == "FAIL")
    n_gap = sum(1 for r in rows if r["result"] == "ADVISORY" and r.get("advisory_severity") == "warn")
    n_pass = sum(1 for r in rows if r["result"] == "PASS")
    sys.stderr.write(f"audit-harness audit ({'deep' if deep else 'fast'}): {n_pass} PASS, "
                     f"{n_gap} gap(s), {n_fail} FAIL across {len(rows)} testing-depth gate(s)\n")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
