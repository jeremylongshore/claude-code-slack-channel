#!/usr/bin/env python3
"""
audit-harness conform — read-only deterministic conformance gate-runner.

For every conformance-dimension gate in a repo's audit-profile/v1, conform locates
the relevant artifact(s) and validates them against a CONTENT-ADDRESSED schema
BUNDLED in this harness version (never live-fetched). Each artifact yields one
`gate-result/v1` Evidence Bundle row (the predicate body in
schemas/.../gate-result.schema.json / @intentsolutions/core), emitted as a JSON
array on stdout. NEVER writes to the repo.

Design rules (PP-PLAN-040 Phase 2):
  - Deterministic + pure-local. Same commit + same harness version => identical
    verdict. The bundled JSON-Schema is validated by an EMBEDDED subset validator
    (not ajv) precisely BECAUSE ajv's availability/version varies per box and would
    make signed evidence non-reproducible. The embedded validator is complete for
    the closed bundled schemas (which use only the keyword subset it supports).
  - Genuinely-external formats shell out: OpenAPI -> spectral, Action YAML ->
    yamllint. Missing tool => INDETERMINATE (advisory), never a false FAIL.
  - Advisory-first. A conformance violation on an `enforcement: advisory` gate is
    ADVISORY (severity error), exit 0 — the finding is logged, the build is not
    reddened. Only an engineer-promoted `enforcement: blocking` gate (or --strict)
    turns a violation into FAIL (exit 1).
  - conform records the bundled schema's sha256 in the gate-result `policy_hash`,
    so a row re-verifies against the exact schema version that produced it.
  - Stdlib only (PyYAML used for frontmatter when present; absent => indeterminate
    rather than a guessed verdict). No network. No filesystem mutation.

Usage:
  python3 scripts/conform.py [REPO_PATH] [--json] [--strict] [--profile PATH|-]
  AUDIT_HARNESS_DISABLE=1 python3 scripts/conform.py   # kill-switch (no-op, exit 0)
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import classify as C  # noqa: E402  (sibling module; reused for the single-source profile)

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover - exercised only on boxes without PyYAML
    yaml = None

SCHEMA_DIR = os.path.join(HERE, "..", "schemas", "conform", "v1")
EMPTY_SHA = "sha256:" + hashlib.sha256(b"").hexdigest()

# kind -> bundled schema filename (content-addressed in this harness version)
BUNDLED = {
    "skillmd": "skillmd-frontmatter.schema.json",
    "agent": "agent-frontmatter.schema.json",
    "mcp": "mcp-config.schema.json",
    "plugin": "plugin-manifest.schema.json",
}
FRONTMATTER_KINDS = {"skillmd", "agent"}      # YAML frontmatter in a .md file
JSON_KINDS = {"mcp", "plugin", "marketplace", "hook"}  # whole-file JSON
SHELLOUT = {                                   # genuinely-external linters
    "openapi": "spectral",
    "action": "yamllint",
}


# --------------------------------------------------------------------------- #
# Embedded JSON-Schema subset validator (complete for the closed bundled schemas)
# --------------------------------------------------------------------------- #
def _type_ok(value, t):
    if t == "boolean":
        return isinstance(value, bool)
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "null":
        return value is None
    if t == "object":
        return isinstance(value, dict)
    if t == "array":
        return isinstance(value, list)
    if t == "string":
        return isinstance(value, str)
    return True


def validate_instance(inst, schema, path="$"):
    """Return a list of human-readable violation strings ([] == valid)."""
    errs = []
    if not isinstance(schema, dict):
        return errs

    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_type_ok(inst, x) for x in types):
            errs.append(f"{path}: expected type {t}, got {type(inst).__name__}")
            return errs  # downstream keyword checks are meaningless on a type mismatch

    if "enum" in schema and inst not in schema["enum"]:
        errs.append(f"{path}: {inst!r} not in enum {schema['enum']}")
    if "const" in schema and inst != schema["const"]:
        errs.append(f"{path}: {inst!r} != const {schema['const']!r}")

    if isinstance(inst, str):
        if "minLength" in schema and len(inst) < schema["minLength"]:
            errs.append(f"{path}: shorter than minLength {schema['minLength']}")
        if "maxLength" in schema and len(inst) > schema["maxLength"]:
            errs.append(f"{path}: longer than maxLength {schema['maxLength']}")
        if "pattern" in schema and re.search(schema["pattern"], inst) is None:
            errs.append(f"{path}: does not match pattern {schema['pattern']!r}")
        if schema.get("format") in ("uri", "url") and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:", inst):
            errs.append(f"{path}: not a {schema['format']}")

    if isinstance(inst, list):
        if "minItems" in schema and len(inst) < schema["minItems"]:
            errs.append(f"{path}: fewer than minItems {schema['minItems']}")
        if "maxItems" in schema and len(inst) > schema["maxItems"]:
            errs.append(f"{path}: more than maxItems {schema['maxItems']}")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, el in enumerate(inst):
                errs += validate_instance(el, item_schema, f"{path}[{i}]")

    if isinstance(inst, dict):
        for req in schema.get("required", []):
            if req not in inst:
                errs.append(f"{path}: missing required property '{req}'")
        props = schema.get("properties", {})
        for k, sub in props.items():
            if k in inst:
                errs += validate_instance(inst[k], sub, f"{path}.{k}")
        ap = schema.get("additionalProperties", True)
        if ap is False:
            for k in inst:
                if k not in props:
                    errs.append(f"{path}: additional property '{k}' not allowed")
        elif isinstance(ap, dict):
            for k, v in inst.items():
                if k not in props:
                    errs += validate_instance(v, ap, f"{path}.{k}")

    for sub in schema.get("allOf", []):
        errs += validate_instance(inst, sub, path)
    if "anyOf" in schema:
        if not any(not validate_instance(inst, sub, path) for sub in schema["anyOf"]):
            errs.append(f"{path}: matches none of anyOf")
    if "oneOf" in schema:
        matches = sum(1 for sub in schema["oneOf"] if not validate_instance(inst, sub, path))
        if matches != 1:
            errs.append(f"{path}: matched {matches} of oneOf branches (need exactly 1)")
    return errs


# --------------------------------------------------------------------------- #
# Artifact location + parsing
# --------------------------------------------------------------------------- #
SKIP_DIRS = ("node_modules", ".git", ".venv", "dist", "build",
             "fixtures", "tests", "test", "__tests__", "examples")


def find_files(repo, name, max_depth=3):
    repo = os.path.abspath(repo)
    out = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        depth = root[len(repo):].count(os.sep)
        if depth > max_depth:
            dirs[:] = []
            continue
        if name in files:
            out.append(os.path.join(root, name))
    return sorted(out)


def locate(kind, repo):
    """Return the list of artifact file paths for a conformance kind."""
    repo = os.path.abspath(repo)

    def first_existing(*rels):
        return [os.path.join(repo, r) for r in rels if os.path.isfile(os.path.join(repo, r))]

    if kind == "skillmd":
        return find_files(repo, "SKILL.md")
    if kind == "agent":
        out = []
        for d in (os.path.join(repo, "agents"), os.path.join(repo, ".claude", "agents")):
            if os.path.isdir(d):
                out += [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".md")]
        return out
    if kind == "mcp":
        out = first_existing(".mcp.json")
        for sub in C.list_pkg_subdirs(repo):
            p = os.path.join(sub, ".mcp.json")
            if os.path.isfile(p):
                out.append(p)
        return out
    if kind == "plugin":
        return first_existing(".claude-plugin/plugin.json", "plugin.json")
    if kind == "marketplace":
        return first_existing(".claude-plugin/marketplace.json", "marketplace.json")
    if kind == "hook":
        out = first_existing("hooks/hooks.json")
        hd = os.path.join(repo, ".claude", "hooks")
        if os.path.isdir(hd):
            out += [os.path.join(hd, f) for f in sorted(os.listdir(hd)) if f.endswith(".json")]
        return out
    if kind == "openapi":
        return first_existing("openapi.yaml", "openapi.yml", "openapi.json",
                              "swagger.yaml", "swagger.json")
    if kind == "action":
        return first_existing("action.yml", "action.yaml")
    return []


def parse_json_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f), None
    except json.JSONDecodeError as e:
        return None, f"json-parse-error: {e}"
    except Exception as e:
        return None, f"read-error: {e}"


def extract_frontmatter(path):
    """Return (dict, None) or (None, reason). Requires PyYAML for a reliable verdict."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception as e:
        return None, f"read-error: {e}"
    if not text.lstrip().startswith("---"):
        return None, "no-frontmatter-block"
    m = re.match(r"^﻿?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(\r?\n|$)", text, re.DOTALL)
    if not m:
        return None, "unterminated-frontmatter-block"
    block = m.group(1)
    if yaml is None:
        return None, "pyyaml-unavailable"  # honest indeterminate, not a guessed parse
    try:
        data = yaml.safe_load(block)
    except Exception as e:
        return None, f"yaml-parse-error: {e}"
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return None, "frontmatter-not-a-mapping"
    return data, None


# --------------------------------------------------------------------------- #
# gate-result/v1 row construction
# --------------------------------------------------------------------------- #
def sha256_path(path):
    try:
        return C.sha256_file(path)
    except Exception:
        return EMPTY_SHA


def sha256_str(s):
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()


def make_row(gate_id, result, *, policy_hash, input_hash, commit_sha, runner,
             metadata=None, failure_mode=None, advisory_severity=None):
    row = {
        "gate_id": gate_id,
        "result": result,
        "policy_hash": policy_hash,
        "input_hash": input_hash,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runner": runner,
        "commit_sha": commit_sha,
    }
    if metadata:
        row["metadata"] = metadata
    if failure_mode is not None:
        row["failure_mode"] = failure_mode
    if advisory_severity is not None:
        row["advisory_severity"] = advisory_severity
    return row


def verdict_for(errs, parse_err, enforcement, strict):
    """Map (violations, parse error, enforcement) -> (result, failure_mode, severity)."""
    violated = bool(errs) or parse_err is not None
    if not violated:
        return "PASS", None, None
    blocking = strict or enforcement == "blocking"
    if blocking:
        fm = "conform:parse-error" if parse_err is not None else "conform:schema-violation"
        return "FAIL", fm, None
    return "ADVISORY", None, "error"


# --------------------------------------------------------------------------- #
def compute_profile(repo, registry_path, profile_arg):
    if profile_arg == "-":
        return json.load(sys.stdin)
    if profile_arg:
        with open(profile_arg, "r", encoding="utf-8") as f:
            return json.load(f)
    out = subprocess.run(
        [sys.executable, os.path.join(HERE, "classify.py"), repo, "--registry", registry_path],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.stderr.write(out.stderr)
        raise SystemExit(2)
    return json.loads(out.stdout)


def kind_of(gate_id):
    """audit-harness:local:conform-skillmd -> 'skillmd'."""
    seg = gate_id.rsplit(":", 1)[-1]
    return seg[len("conform-"):] if seg.startswith("conform-") else seg


def run_shellout(kind, gate, files, commit_sha, runner, repo, strict):
    tool = SHELLOUT[kind]
    rows = []
    enforcement = gate.get("enforcement", "advisory")
    if shutil.which(tool) is None:
        rows.append(make_row(
            gate["gate_id"], "ADVISORY",
            policy_hash=sha256_str(f"{tool}:default"),
            input_hash=sha256_path(files[0]) if files else EMPTY_SHA,
            commit_sha=commit_sha, runner=runner, advisory_severity="warn",
            metadata={"kind": kind, "validator": tool, "indeterminate": True,
                      "reason": f"{tool} not on PATH — conformance unmeasured"},
        ))
        return rows
    for art in files:
        cmd = [tool, "lint", art] if tool == "spectral" else [tool, art]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            errs = [] if proc.returncode == 0 else [(proc.stdout or proc.stderr).strip()[:2000]]
            parse_err = None
        except Exception as e:
            errs, parse_err = [], None
            rows.append(make_row(
                gate["gate_id"], "ADVISORY",
                policy_hash=sha256_str(f"{tool}:default"), input_hash=sha256_path(art),
                commit_sha=commit_sha, runner=runner, advisory_severity="warn",
                metadata={"kind": kind, "validator": tool, "indeterminate": True,
                          "artifact_path": os.path.relpath(art, repo), "reason": str(e)},
            ))
            continue
        result, fm, sev = verdict_for(errs, parse_err, enforcement, strict)
        rows.append(make_row(
            gate["gate_id"], result,
            policy_hash=sha256_str(f"{tool}:default"), input_hash=sha256_path(art),
            commit_sha=commit_sha, runner=runner, failure_mode=fm, advisory_severity=sev,
            metadata={"kind": kind, "validator": tool,
                      "artifact_path": os.path.relpath(art, repo),
                      "errors": errs[:20]},
        ))
    return rows


def run_bundled(kind, gate, files, commit_sha, runner, repo, strict):
    rows = []
    enforcement = gate.get("enforcement", "advisory")
    schema_path = os.path.join(SCHEMA_DIR, BUNDLED[kind])
    schema = C.read_json(schema_path)
    if schema is None:
        rows.append(make_row(
            gate["gate_id"], "ADVISORY",
            policy_hash=EMPTY_SHA, input_hash=EMPTY_SHA, commit_sha=commit_sha,
            runner=runner, advisory_severity="warn",
            metadata={"kind": kind, "indeterminate": True,
                      "reason": f"bundled schema missing at {BUNDLED[kind]}"},
        ))
        return rows
    policy_hash = C.sha256_file(schema_path)
    schema_id = schema.get("$id", "")
    for art in files:
        if kind in FRONTMATTER_KINDS:
            data, parse_err = extract_frontmatter(art)
        else:
            data, parse_err = parse_json_file(art)

        if parse_err == "pyyaml-unavailable":
            rows.append(make_row(
                gate["gate_id"], "ADVISORY",
                policy_hash=policy_hash, input_hash=sha256_path(art), commit_sha=commit_sha,
                runner=runner, advisory_severity="warn",
                metadata={"kind": kind, "validator": "audit-harness-embedded-subset",
                          "schema_id": schema_id, "indeterminate": True,
                          "artifact_path": os.path.relpath(art, repo),
                          "reason": "PyYAML unavailable — frontmatter conformance unmeasured"},
            ))
            continue

        errs = validate_instance(data, schema) if parse_err is None else []
        result, fm, sev = verdict_for(errs, parse_err, enforcement, strict)
        meta = {"kind": kind, "validator": "audit-harness-embedded-subset",
                "schema_id": schema_id, "artifact_path": os.path.relpath(art, repo)}
        if parse_err is not None:
            meta["errors"] = [parse_err]
        elif errs:
            meta["errors"] = errs[:20]
        rows.append(make_row(
            gate["gate_id"], result, policy_hash=policy_hash, input_hash=sha256_path(art),
            commit_sha=commit_sha, runner=runner, failure_mode=fm, advisory_severity=sev,
            metadata=meta,
        ))
    return rows


def main():
    ap = argparse.ArgumentParser(description="Read-only conformance gate-runner -> gate-result/v1 rows")
    ap.add_argument("repo", nargs="?", default=".", help="Repo path (default: cwd)")
    ap.add_argument("--json", action="store_true", help="Emit JSON (default; flag is for CLI symmetry)")
    ap.add_argument("--strict", action="store_true",
                    help="Treat every conformance violation as FAIL (exit 1), ignoring advisory default")
    ap.add_argument("--registry", default=C.DEFAULT_REGISTRY, help="Path to the dimension-to-gate registry")
    ap.add_argument("--profile", default=None,
                    help="Use a pinned audit-profile/v1 (PATH or '-' for stdin) instead of classifying")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    registry_path = os.path.abspath(args.registry)
    runner = f"audit-harness@{C.harness_version()}"

    override_path = os.path.join(repo, ".audit-harness.yml")
    override = C.parse_override(override_path) if os.path.isfile(override_path) else {"disable": False}
    if override.get("disable") or os.environ.get("AUDIT_HARNESS_DISABLE") == "1":
        sys.stderr.write("audit-harness: KILL-SWITCH active — conform skipped (no rows emitted)\n")
        print("[]")
        sys.exit(0)

    profile = compute_profile(repo, registry_path, args.profile)
    commit_sha = profile.get("subject", {}).get("commit_sha") or C.git_short_sha(repo)

    conf_gates = [g for g in profile.get("gates", [])
                  if g.get("dimension") == "conformance" and g.get("enforcement") != "disabled"]

    rows = []
    for gate in conf_gates:
        kind = kind_of(gate["gate_id"])
        files = locate(kind, repo)
        if not files:
            rows.append(make_row(
                gate["gate_id"], "NOT_APPLICABLE",
                policy_hash=EMPTY_SHA, input_hash=EMPTY_SHA, commit_sha=commit_sha,
                runner=runner, metadata={"kind": kind, "reason": "no matching artifact found in repo"},
            ))
            continue
        if kind in BUNDLED:
            rows += run_bundled(kind, gate, files, commit_sha, runner, repo, args.strict)
        elif kind in SHELLOUT:
            rows += run_shellout(kind, gate, files, commit_sha, runner, repo, args.strict)
        else:
            rows.append(make_row(
                gate["gate_id"], "ADVISORY",
                policy_hash=EMPTY_SHA, input_hash=sha256_path(files[0]), commit_sha=commit_sha,
                runner=runner, advisory_severity="warn",
                metadata={"kind": kind, "indeterminate": True,
                          "reason": f"no bundled conform schema for kind '{kind}' in this harness version"},
            ))

    print(json.dumps(rows, indent=2))

    n_fail = sum(1 for r in rows if r["result"] == "FAIL")
    n_adv = sum(1 for r in rows if r["result"] == "ADVISORY")
    n_pass = sum(1 for r in rows if r["result"] == "PASS")
    sys.stderr.write(f"audit-harness conform: {n_pass} PASS, {n_adv} ADVISORY, {n_fail} FAIL "
                     f"across {len(rows)} row(s)\n")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
