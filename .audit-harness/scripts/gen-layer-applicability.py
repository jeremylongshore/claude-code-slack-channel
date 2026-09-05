#!/usr/bin/env python3
"""
audit-harness gen-layer-applicability — project the canonical registry datum into
the human-readable layer-applicability matrix.

`schemas/audit-profile/registry.v1.json` is THE single source of truth for "which
gates apply to repo-type X, in which dimension, at what applicability". This
generator renders `schemas/audit-profile/layer-applicability.md` as a PROJECTION
of that datum so the doc can never silently drift from the registry the classifier
actually resolves against (PP-PLAN-040 Phase 0, bead c2b).

Modes:
  (default)      print the rendered markdown to stdout
  --write        write it to schemas/audit-profile/layer-applicability.md
  --check        regenerate in-memory and diff against the committed file;
                 exit 1 on drift (the CI `layer-applicability-drift` gate)

Stdlib only. Read-only except in --write mode (which only writes the one doc).
"""
import argparse
import difflib
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, "..", "schemas", "audit-profile", "registry.v1.json")
DOC = os.path.join(HERE, "..", "schemas", "audit-profile", "layer-applicability.md")

GLYPH = {"required": "✅", "recommended": "⭕", "conditional": "⚠", "waived": "❌"}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def row(gate):
    app = gate.get("applicability", "")
    return "| `{gid}` | {dim} | {glyph} {app} | {enf} | {tool} |".format(
        gid=gate["gate_id"],
        dim=gate.get("dimension", ""),
        glyph=GLYPH.get(app, ""),
        app=app,
        enf=gate.get("enforcement", "advisory"),
        tool=("`" + gate["tool"] + "`") if gate.get("tool") else "—",
    )


def table(gates):
    out = ["| Gate | Dimension | Applicability | Enforcement | Tool |",
           "|---|---|---|---|---|"]
    out += [row(g) for g in sorted(gates, key=lambda g: (g.get("dimension", ""), g["gate_id"]))]
    return "\n".join(out)


def render(registry, registry_hash):
    lines = []
    a = lines.append
    a("# Layer Applicability — GENERATED from `registry.v1.json`")
    a("")
    a("> ⚠️ **GENERATED FILE — do not edit by hand.**")
    a("> Source of truth: [`registry.v1.json`](registry.v1.json) "
      "(the canonical dimension→gate datum; `classify` resolves against it).")
    a("> Regenerate: `audit-harness gen-layer-applicability --write` "
      "(or `python3 scripts/gen-layer-applicability.py --write`).")
    a("> CI gate `layer-applicability-drift` fails the build if this file drifts from the registry.")
    a(">")
    a(f"> registry `{registry_hash}`")
    a("")
    a(registry.get("description", "").strip())
    a("")
    a("**Legend (applicability):** "
      + " · ".join(f"{GLYPH[k]} {k}" for k in ("required", "recommended", "conditional", "waived")))
    a("")
    a("Every gate defaults to `enforcement: advisory`. Blocking is **earned** — "
      "engineer-pinned in the target repo's `tests/TESTING.md`, FP-rate-gated "
      "(see [`gate-promotion.md`](../../docs/gate-promotion.md)).")
    a("")
    a("## Base gates (apply to every repo)")
    a("")
    a(table(registry.get("base", [])))
    a("")
    a("## By classification")
    a("")
    a("A repo carries the **UNION** of every classification it matches "
      "(`classify` never picks a single winner). Gates dedup by `gate_id`, "
      "keeping the highest applicability.")
    a("")
    for kind in sorted(registry.get("classifications", {})):
        a(f"### `{kind}`")
        a("")
        a(table(registry["classifications"][kind]))
        a("")
    overlays = registry.get("overlays", {})
    if overlays:
        a("## Overlays")
        a("")
        for name in sorted(overlays):
            ov = overlays[name]
            a(f"### `{name}`")
            a("")
            a(ov.get("description", "").strip())
            promote = ov.get("promote_to_required", [])
            if promote:
                a("")
                a("Promotes to **required**: " + ", ".join(f"`{d}`" for d in promote) + ".")
            a("")
    return "\n".join(lines).rstrip() + "\n"


def main():
    ap = argparse.ArgumentParser(description="Project registry.v1.json -> layer-applicability.md")
    ap.add_argument("--write", action="store_true", help="write the doc to its canonical path")
    ap.add_argument("--check", action="store_true", help="fail (exit 1) if the committed doc drifts")
    ap.add_argument("--registry", default=REGISTRY)
    ap.add_argument("--out", default=DOC)
    args = ap.parse_args()

    registry_path = os.path.abspath(args.registry)
    with open(registry_path, "r", encoding="utf-8") as f:
        registry = json.load(f)
    rendered = render(registry, sha256_file(registry_path))

    if args.check:
        try:
            with open(args.out, "r", encoding="utf-8") as f:
                current = f.read()
        except FileNotFoundError:
            print(f"gen-layer-applicability: {args.out} missing — run --write", file=sys.stderr)
            sys.exit(1)
        if current != rendered:
            diff = difflib.unified_diff(
                current.splitlines(True), rendered.splitlines(True),
                fromfile="committed", tofile="generated",
            )
            sys.stderr.write("".join(diff))
            sys.stderr.write("\ngen-layer-applicability: DRIFT — regenerate with --write\n")
            sys.exit(1)
        print("gen-layer-applicability: layer-applicability.md matches the registry datum")
        sys.exit(0)

    if args.write:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(rendered)
        print(f"gen-layer-applicability: wrote {os.path.relpath(args.out, os.path.join(HERE, '..'))}")
        sys.exit(0)

    sys.stdout.write(rendered)


if __name__ == "__main__":
    main()
