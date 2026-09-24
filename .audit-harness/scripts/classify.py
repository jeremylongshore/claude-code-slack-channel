#!/usr/bin/env python3
"""
audit-harness classify — read-only deterministic repository classifier.

Emits an `audit-profile/v1` value (the data-first value specified in
schemas/audit-profile/v1.schema.json) to stdout as JSON. NEVER writes to the repo.

A profile is a deterministic function of:
  (repo contents at commit_sha, the canonical dimension-to-gate registry pinned by
   registry_hash, and any engineer .audit-harness.yml overrides).

Design rules (PP-PLAN-040):
  - Classifications are a UNION, not a winner. A repo that is a monorepo AND ships a
    SKILL.md AND an MCP server carries all three. Dropping any is a false-negative.
  - unresolved[] is the only surface a Claude inspector may later refine.
  - Stdlib only (json, hashlib, os, re, subprocess, datetime). No third-party deps.
  - No network. No filesystem mutation.

Usage:
  python3 scripts/classify.py [REPO_PATH] [--json] [--registry PATH]
  AUDIT_HARNESS_DISABLE=1 python3 scripts/classify.py   # kill-switch
  AUDIT_HARNESS_ADVISORY=gate-id,gate-id ...            # force-advisory specific gates
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_REGISTRY = os.path.join(HERE, "..", "schemas", "audit-profile", "registry.v1.json")

APPLICABILITY_RANK = {"required": 3, "recommended": 2, "conditional": 1, "waived": 0}
FRONTEND_DEPS = ("react", "vue", "svelte", "solid-js", "next", "nuxt", "@angular/core", "preact")
SERVER_DEPS = ("express", "fastify", "koa", "@hapi/hapi", "@nestjs/core", "restify")
PY_SERVER = ("fastapi", "flask", "django")
REGULATED_MARKERS = ("HIPAA", "SOX", "PCI-DSS", "SOC2", "GDPR", "FedRAMP")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def git_short_sha(repo):
    try:
        out = subprocess.run(
            ["git", "-C", repo, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        sha = out.stdout.strip()
        if re.fullmatch(r"[a-f0-9]{7,40}", sha):
            return sha
    except Exception:
        pass
    return "0000000"


def harness_version():
    vt = os.path.join(HERE, "..", "version.txt")
    try:
        with open(vt, "r", encoding="utf-8") as f:
            v = f.read().strip()
            if v:
                return v
    except Exception:
        pass
    pkg = read_json(os.path.join(HERE, "..", "package.json")) or {}
    return pkg.get("version", "0.0.0")


def parse_override(path):
    """Minimal, well-defined subset parser for .audit-harness.yml.

    Supported keys ONLY (full YAML is NOT parsed):
      disable: true|false              # kill-switch for this repo
      classify_pins:                   # engineer-declared classification kinds
        - skill
      advisory:                        # force these gate_ids to enforcement=advisory
        - audit-harness:ci:crap-score
      disable_gates:                   # force these gate_ids to enforcement=disabled
        - audit-harness:ci:a11y
    Unknown lines are ignored.
    """
    ov = {"disable": False, "classify_pins": [], "advisory": [], "disable_gates": []}
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        return ov
    current = None
    for raw in lines:
        line = raw.rstrip("\n")
        if not line.strip() or line.strip().startswith("#"):
            continue
        m_item = re.match(r"^\s+-\s+(.+?)\s*$", line)
        if m_item and current in ("classify_pins", "advisory", "disable_gates"):
            ov[current].append(m_item.group(1).strip().strip("\"'"))
            continue
        m_kv = re.match(r"^([A-Za-z_]+)\s*:\s*(.*)$", line)
        if m_kv:
            key, val = m_kv.group(1), m_kv.group(2).strip()
            if key == "disable":
                ov["disable"] = val.lower() in ("true", "yes", "1")
                current = None
            elif key in ("classify_pins", "advisory", "disable_gates"):
                current = key
                if val:  # inline list form: advisory: [a, b]
                    inner = val.strip("[]")
                    ov[key].extend(
                        x.strip().strip("\"'") for x in inner.split(",") if x.strip()
                    )
            else:
                current = None
    return ov


def list_pkg_subdirs(repo):
    pkgs = []
    pdir = os.path.join(repo, "packages")
    if os.path.isdir(pdir):
        for name in sorted(os.listdir(pdir)):
            sub = os.path.join(pdir, name)
            if os.path.isfile(os.path.join(sub, "package.json")):
                pkgs.append(sub)
    return pkgs


def shallow_glob(repo, filename, max_depth=3):
    """True if `filename` exists anywhere within max_depth dirs of repo."""
    repo = os.path.abspath(repo)
    # Exclude vendor/build dirs AND test/fixture dirs so a repo is never classified
    # by its own test fixtures (e.g. a harness whose fixtures contain SKILL.md files).
    skip = ("node_modules", ".git", ".venv", "dist", "build",
            "fixtures", "tests", "test", "__tests__", "examples")
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in skip]
        depth = root[len(repo):].count(os.sep)
        if depth > max_depth:
            dirs[:] = []
            continue
        if filename in files:
            return True
    return False


def repo_type_signals(pkg, root):
    """Repo-type classifications from a package.json + its dir. Returns list of (kind, signal)."""
    found = []
    if not isinstance(pkg, dict):
        return found
    deps = {}
    for k in ("dependencies", "devDependencies", "peerDependencies"):
        if isinstance(pkg.get(k), dict):
            deps.update(pkg[k])
    if any(d in deps for d in FRONTEND_DEPS):
        found.append(("frontend", "package.json:frontend-framework"))
    if any(d in deps for d in SERVER_DEPS):
        found.append(("service", "package.json:server-framework"))
    if pkg.get("bin"):
        found.append(("cli", "package.json:bin"))
    # Library = a publishable package: not explicitly private AND declares an entry
    # surface (main/exports/module/types). Catches published packages that omit the
    # "private" field entirely (the common case) — not just "private": false.
    if pkg.get("private") is not True and any(pkg.get(k) for k in ("main", "exports", "module", "types")):
        found.append(("library", "package.json:publishable(main/exports/types)"))
    if isinstance(pkg.get("mcpServers"), dict):
        found.append(("mcp", "package.json:mcpServers"))
    return found


def classify(repo):
    repo = os.path.abspath(repo)
    found = {}  # kind -> set(signals)

    def add(kind, signal):
        found.setdefault(kind, set()).add(signal)

    def has(*rel):
        return any(os.path.exists(os.path.join(repo, r)) for r in rel)

    # --- monorepo ---
    if has("pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json", "rush.json") or list_pkg_subdirs(repo):
        add("monorepo", "workspace-config")

    # --- Claude-ecosystem artifact kinds ---
    if shallow_glob(repo, "SKILL.md"):
        add("skill", "SKILL.md present")
    if os.path.isdir(os.path.join(repo, "agents")) or os.path.isdir(os.path.join(repo, ".claude", "agents")):
        add("agent", "agents/ dir")
    if has("hooks/hooks.json") or os.path.isdir(os.path.join(repo, ".claude", "hooks")):
        add("hook", "hooks config")
    if has(".mcp.json"):
        add("mcp", ".mcp.json present")
    if os.path.isdir(os.path.join(repo, ".claude-plugin")) or has("plugin.json", ".claude-plugin/plugin.json"):
        add("plugin", ".claude-plugin/")
    if has(".claude-plugin/marketplace.json", "marketplace.json"):
        add("marketplace", "marketplace.json")
    if has("action.yml", "action.yaml"):
        add("action", "action.yml")

    # --- API (spec presence) ---
    if has("openapi.yaml", "openapi.json", "openapi.yml", "swagger.yaml", "swagger.json"):
        add("api", "openapi/swagger spec")

    # --- root package.json repo-types ---
    root_pkg = read_json(os.path.join(repo, "package.json"))
    for kind, sig in repo_type_signals(root_pkg, repo):
        add(kind, sig)

    # --- python server frameworks ---
    for pyfile in ("requirements.txt", "pyproject.toml", "Pipfile"):
        p = os.path.join(repo, pyfile)
        if os.path.isfile(p):
            try:
                txt = open(p, "r", encoding="utf-8").read().lower()
                if any(f in txt for f in PY_SERVER):
                    add("service", "python:server-framework")
            except Exception:
                pass

    # --- monorepo package-level repo-types (one level deep) ---
    for sub in list_pkg_subdirs(repo):
        sub_pkg = read_json(os.path.join(sub, "package.json"))
        for kind, sig in repo_type_signals(sub_pkg, sub):
            add(kind, "packages/*:" + sig.split(":", 1)[-1])
        if has_mcp(sub):
            add("mcp", "packages/*:.mcp.json")

    # --- embedded (C/C++) ---
    is_c = shallow_glob(repo, "main.c") or _has_ext(repo, (".c", ".cpp", ".cc"))
    if has("Makefile", "CMakeLists.txt") and is_c and not root_pkg:
        add("embedded", "C/C++ build + sources")

    # --- regulated overlay ---
    for marker_file in ("README.md", "SECURITY.md"):
        p = os.path.join(repo, marker_file)
        if os.path.isfile(p):
            try:
                txt = open(p, "r", encoding="utf-8").read()
                if any(m in txt for m in REGULATED_MARKERS):
                    add("regulated", "compliance marker")
                    break
            except Exception:
                pass

    return found


def has_mcp(sub):
    return os.path.exists(os.path.join(sub, ".mcp.json"))


def _has_ext(repo, exts):
    for _root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", ".venv")]
        if any(f.endswith(exts) for f in files):
            return True
    return False


def resolve_gates(kinds, registry, regulated, override):
    """UNION base + per-classification gates; dedup by gate_id keeping highest applicability."""
    by_id = {}

    def merge(gate):
        gid = gate["gate_id"]
        existing = by_id.get(gid)
        new_rank = APPLICABILITY_RANK.get(gate["applicability"], 0)
        old_rank = APPLICABILITY_RANK.get(existing["applicability"], 0) if existing else -1
        if existing is None or new_rank > old_rank:
            by_id[gid] = dict(gate)

    for gate in registry.get("base", []):
        merge(gate)
    cmap = registry.get("classifications", {})
    for k in kinds:
        for gate in cmap.get(k, []):
            merge(gate)

    # regulated overlay: promote recommended -> required for listed dimensions
    if regulated:
        promote_dims = set(registry.get("overlays", {}).get("regulated", {}).get("promote_to_required", []))
        for g in by_id.values():
            if g.get("dimension") in promote_dims and g["applicability"] == "recommended":
                g["applicability"] = "required"

    # engineer overrides: force advisory / disabled per gate_id
    for gid in override.get("advisory", []):
        if gid in by_id:
            by_id[gid]["enforcement"] = "advisory"
    for gid in override.get("disable_gates", []):
        if gid in by_id:
            by_id[gid]["enforcement"] = "disabled"

    # invariant: waived -> disabled
    for g in by_id.values():
        if g["applicability"] == "waived":
            g["enforcement"] = "disabled"

    return [by_id[k] for k in sorted(by_id)]


def main():
    ap = argparse.ArgumentParser(description="Read-only repository classifier -> audit-profile/v1")
    ap.add_argument("repo", nargs="?", default=".", help="Repo path (default: cwd)")
    ap.add_argument("--json", action="store_true", help="Emit JSON (default; flag is for symmetry with other gates)")
    ap.add_argument("--registry", default=DEFAULT_REGISTRY, help="Path to the dimension-to-gate registry datum")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    registry_path = os.path.abspath(args.registry)
    registry = read_json(registry_path)
    if registry is None:
        print(f"classify: registry not found at {registry_path}", file=sys.stderr)
        sys.exit(2)
    registry_hash = sha256_file(registry_path)

    # engineer override file
    override_path = os.path.join(repo, ".audit-harness.yml")
    override = parse_override(override_path) if os.path.isfile(override_path) else {
        "disable": False, "classify_pins": [], "advisory": [], "disable_gates": []
    }
    kill = override.get("disable") or os.environ.get("AUDIT_HARNESS_DISABLE") == "1"
    for gid in os.environ.get("AUDIT_HARNESS_ADVISORY", "").split(","):
        if gid.strip():
            override["advisory"].append(gid.strip())

    found = classify(repo)

    # engineer classification pins (declared)
    for k in override.get("classify_pins", []):
        found.setdefault(k, set()).add("override:classify_pin")

    classifications = []
    unresolved = []
    for kind in sorted(found):
        conf = "declared" if "override:classify_pin" in found[kind] else "detected"
        classifications.append({
            "kind": kind, "confidence": conf, "signals": sorted(found[kind]),
        })

    if not classifications:
        classifications.append({"kind": "unknown", "confidence": "unresolved", "signals": []})
        unresolved.append({
            "kind": "repo-type",
            "reason": ("no deterministic repo-type or artifact signal matched; "
                       "a human (or /audit-tests) must declare the classification"),
        })

    regulated = "regulated" in found
    gates = resolve_gates([c["kind"] for c in classifications], registry, regulated, override)

    overrides_block = None
    if os.path.isfile(override_path) or kill:
        overrides_block = {"source": ".audit-harness.yml", "kill_switch": bool(kill)}
        if os.path.isfile(override_path):
            overrides_block["override_hash"] = sha256_file(override_path)

    if kill:
        for g in gates:
            g["enforcement"] = "disabled"
        print("audit-harness: KILL-SWITCH active — all gates disabled "
              "(AUDIT_HARNESS_DISABLE / .audit-harness.yml)", file=sys.stderr)

    profile = {
        "schema_version": "audit-profile/v1",
        "subject": {"name": os.path.basename(repo), "commit_sha": git_short_sha(repo), "root": "."},
        "classifier": f"audit-harness@{harness_version()}",
        "registry_hash": registry_hash,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "classifications": classifications,
        "dimensions": sorted({g["dimension"] for g in gates}),
        "gates": gates,
        "unresolved": unresolved,
    }
    if overrides_block is not None:
        profile["overrides"] = overrides_block

    # subject.name from root package.json if present
    if isinstance(root_pkg_name := (read_json(os.path.join(repo, "package.json")) or {}).get("name"), str):
        profile["subject"]["name"] = root_pkg_name

    print(json.dumps(profile, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main()
