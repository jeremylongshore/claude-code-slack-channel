#!/usr/bin/env python3
"""
audit-harness scan — read-only security / hygiene / skill-quality gate-runner
(PP-PLAN-040 Phase 4 / E6).

For every `dimension: security | hygiene | skill-quality` gate in a repo's
audit-profile/v1, scan runs the right external tool with the repo present and wraps
its exit code into a `gate-result/v1` row (JSON array, stdout). Advisory-first; a
missing tool degrades to ADVISORY indeterminate (never a false FAIL). It NEVER
fixes anything and NEVER reimplements a scanner.

Strategies:
  - local      hygiene-readme: deterministic README presence check (no tool).
  - shell-out  every gate carrying a `tool` (gitleaks, osv-scanner, semgrep, syft,
               markdownlint, lychee, ...): run it if on PATH; clean exit -> PASS;
               findings -> ADVISORY(error) (or FAIL under --strict / blocking);
               tool absent -> ADVISORY indeterminate.
  - consume    skill-quality skill-behavioral (tool j-rig): CONSUME a j-rig
               Evidence Bundle verdict row (--jrig-verdict PATH or a default
               location). The harness does NOT run behavioral judgment itself —
               it ingests j-rig's verdict. No verdict -> ADVISORY indeterminate.

Stdlib only. No network beyond whatever the shelled-out tool does (and the only
network-touching gates fail open to indeterminate). No filesystem mutation.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import classify as C  # noqa: E402

EMPTY_SHA = "sha256:" + hashlib.sha256(b"").hexdigest()
SCAN_DIMENSIONS = {"security", "hygiene", "skill-quality"}

# tool -> argv (run with cwd=repo). "generation" tools (syft) are PASS on exit 0,
# INDETERMINATE on failure (they produce an artifact, they don't pass/fail policy).
TOOL_CMD = {
    "gitleaks": (["gitleaks", "detect", "--no-banner"], "scan"),
    "osv-scanner": (["osv-scanner", "-r", "."], "scan"),
    "semgrep": (["semgrep", "scan", "--error", "--quiet"], "scan"),
    "syft": (["syft", "."], "generation"),
    "markdownlint": (["markdownlint", "."], "scan"),
    "lychee": (["lychee", "--offline", "--no-progress", "."], "scan"),
}


def sha256_str(s):
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()


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


def indeterminate(gate, commit_sha, runner, reason, policy):
    return make_row(gate["gate_id"], "ADVISORY", policy_hash=sha256_str(policy),
                    input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                    advisory_severity="warn",
                    metadata={"indeterminate": True, "reason": reason})


def run_readme(repo, gate, commit_sha, runner, strict):
    enforcement = gate.get("enforcement", "advisory")
    present = any(os.path.isfile(os.path.join(repo, n))
                 for n in ("README.md", "README.rst", "README.txt", "README"))
    if present:
        return make_row(gate["gate_id"], "PASS", policy_hash=sha256_str("hygiene:readme"),
                        input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                        metadata={"method": "local-presence", "signal": "README present"})
    result, fm, sev = ("FAIL", "hygiene:readme-missing", None) if (strict or enforcement == "blocking") \
        else ("ADVISORY", None, "warn")
    return make_row(gate["gate_id"], result, policy_hash=sha256_str("hygiene:readme"),
                    input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                    failure_mode=fm, advisory_severity=sev,
                    metadata={"method": "local-presence", "reason": "no README found"})


def run_tool(tool, repo, gate, commit_sha, runner, strict):
    enforcement = gate.get("enforcement", "advisory")
    policy = f"tool:{tool}"
    if tool not in TOOL_CMD:
        return indeterminate(gate, commit_sha, runner,
                             f"no invocation wired for tool '{tool}'", policy)
    if shutil.which(tool) is None:
        return indeterminate(gate, commit_sha, runner,
                             f"{tool} not on PATH — {gate.get('dimension')} unmeasured", policy)
    argv, kind = TOOL_CMD[tool]
    try:
        proc = subprocess.run(argv, cwd=repo, capture_output=True, text=True, timeout=300)
    except Exception as e:
        return indeterminate(gate, commit_sha, runner, f"{tool} failed to run: {e}", policy)
    if proc.returncode == 0:
        return make_row(gate["gate_id"], "PASS", policy_hash=sha256_str(policy),
                        input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                        metadata={"method": "shell-out", "tool": tool})
    if kind == "generation":
        # syft etc. failing to generate is infra, not a policy violation
        return indeterminate(gate, commit_sha, runner,
                             f"{tool} could not generate artifact (exit {proc.returncode})", policy)
    detail = (proc.stdout or proc.stderr).strip()[:2000]
    result, fm, sev = ("FAIL", f"scan:{tool}-findings", None) if (strict or enforcement == "blocking") \
        else ("ADVISORY", None, "error")
    return make_row(gate["gate_id"], result, policy_hash=sha256_str(policy),
                    input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                    failure_mode=fm, advisory_severity=sev,
                    metadata={"method": "shell-out", "tool": tool, "detail": detail})


def consume_jrig(repo, gate, commit_sha, runner, strict, verdict_path):
    """Ingest a j-rig Evidence Bundle verdict row — never run judgment here."""
    policy = "consume:j-rig"
    candidates = [verdict_path] if verdict_path else []
    candidates += [os.path.join(repo, p) for p in
                   (".j-rig/verdict.json", ".jrig/verdict.json", "j-rig-verdict.json")]
    path = next((p for p in candidates if p and os.path.isfile(p)), None)
    if path is None:
        return indeterminate(gate, commit_sha, runner,
                             "no j-rig verdict available — run j-rig eval and pass --jrig-verdict",
                             policy)
    verdict = C.read_json(path)
    if not isinstance(verdict, dict):
        return indeterminate(gate, commit_sha, runner, f"unreadable j-rig verdict at {path}", policy)
    # Pass through j-rig's own result if present; otherwise interpret a boolean pass.
    enforcement = gate.get("enforcement", "advisory")
    jres = verdict.get("result") or ("PASS" if verdict.get("passed") else "FAIL")
    meta = {"method": "consume-j-rig", "source": os.path.relpath(path, repo),
            "jrig": {k: verdict.get(k) for k in ("result", "passed", "layers_passed", "baseline_delta")
                     if k in verdict}}
    if jres == "PASS":
        return make_row(gate["gate_id"], "PASS", policy_hash=sha256_str(policy),
                        input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner, metadata=meta)
    result, fm, sev = ("FAIL", "skill-quality:jrig-fail", None) if (strict or enforcement == "blocking") \
        else ("ADVISORY", None, "error")
    return make_row(gate["gate_id"], result, policy_hash=sha256_str(policy),
                    input_hash=EMPTY_SHA, commit_sha=commit_sha, runner=runner,
                    failure_mode=fm, advisory_severity=sev, metadata=meta)


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
    ap = argparse.ArgumentParser(description="Security/hygiene/skill-quality gate-runner -> gate-result/v1")
    ap.add_argument("repo", nargs="?", default=".")
    ap.add_argument("--strict", action="store_true", help="treat a finding/gap as FAIL (exit 1)")
    ap.add_argument("--registry", default=C.DEFAULT_REGISTRY)
    ap.add_argument("--profile", default=None, help="pinned audit-profile/v1 (PATH or '-')")
    ap.add_argument("--jrig-verdict", default=None, help="path to a j-rig Evidence Bundle verdict to consume")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    runner = f"audit-harness@{C.harness_version()}"

    override_path = os.path.join(repo, ".audit-harness.yml")
    override = C.parse_override(override_path) if os.path.isfile(override_path) else {"disable": False}
    if override.get("disable") or os.environ.get("AUDIT_HARNESS_DISABLE") == "1":
        sys.stderr.write("audit-harness: KILL-SWITCH active — scan skipped (no rows emitted)\n")
        print("[]")
        sys.exit(0)

    profile = compute_profile(repo, os.path.abspath(args.registry), args.profile)
    commit_sha = profile.get("subject", {}).get("commit_sha") or C.git_short_sha(repo)

    gates = [g for g in profile.get("gates", [])
             if g.get("dimension") in SCAN_DIMENSIONS and g.get("enforcement") != "disabled"]

    rows = []
    for gate in gates:
        suffix = gate_suffix(gate["gate_id"])
        tool = gate.get("tool")
        if suffix == "hygiene-readme":
            rows.append(run_readme(repo, gate, commit_sha, runner, args.strict))
        elif tool == "j-rig":
            rows.append(consume_jrig(repo, gate, commit_sha, runner, args.strict, args.jrig_verdict))
        elif tool:
            rows.append(run_tool(tool, repo, gate, commit_sha, runner, args.strict))
        else:
            rows.append(indeterminate(gate, commit_sha, runner,
                                      f"gate '{suffix}' has no tool wired in this harness version",
                                      f"scan:{suffix}"))

    print(json.dumps(rows, indent=2))
    n_fail = sum(1 for r in rows if r["result"] == "FAIL")
    n_adv = sum(1 for r in rows if r["result"] == "ADVISORY")
    n_pass = sum(1 for r in rows if r["result"] == "PASS")
    sys.stderr.write(f"audit-harness scan: {n_pass} PASS, {n_adv} ADVISORY, {n_fail} FAIL "
                     f"across {len(rows)} gate(s)\n")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
