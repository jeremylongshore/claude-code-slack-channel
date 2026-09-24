#!/usr/bin/env python3
"""
audit-harness fp-rate — measure a gate's false-positive / false-negative rate over
a labeled corpus.

A new gate ships `enforcement: advisory`. It earns promotion to `blocking` only
once its measured false-positive rate (clean inputs it wrongly flags) sits below a
stated bar on a labeled corpus. This harness produces that measurement — the
evidence an engineer cites when they pin `enforcement: blocking` in a repo's
`tests/TESTING.md` (PP-PLAN-040 Phase 0, bead c2e; rule: docs/gate-promotion.md).

Labeled corpus layout (default `tests/fixtures/conform`):
    <corpus>/valid/<fixture>/...      → every gate that fires here SHOULD be clean
    <corpus>/malformed/<fixture>/...  → every gate that fires here SHOULD flag

Per row the gate emits on a fixture, the verdict is bucketed:
    clean  = PASS | NOT_APPLICABLE
    flag   = FAIL | ADVISORY(advisory_severity=error)
    skip   = ADVISORY indeterminate (tool/schema absent) — unmeasurable, excluded

    false positive (FP) = a `valid` fixture the gate flagged
    false negative (FN) = a `malformed` fixture the gate left clean

Stdlib only. Read-only. Default exit 0 (report); `--max-fp-rate X` exits 1 if any
gate exceeds the bar (use in CI when promoting a gate).
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONFORM = os.path.join(HERE, "conform.py")
DEFAULT_CORPUS = os.path.join(HERE, "..", "tests", "fixtures", "conform")


def verdict_bucket(row):
    r = row.get("result")
    if r in ("PASS", "NOT_APPLICABLE"):
        return "clean"
    if r == "FAIL":
        return "flag"
    if r == "ADVISORY":
        if row.get("metadata", {}).get("indeterminate"):
            return "skip"
        if row.get("advisory_severity") == "error":
            return "flag"
        return "skip"
    return "skip"


def run_conform(fixture):
    out = subprocess.run([sys.executable, CONFORM, fixture], capture_output=True, text=True)
    try:
        return json.loads(out.stdout)
    except Exception:
        return []


def measure(corpus):
    # per gate_id: {valid_total, fp, malformed_total, fn, skipped}
    stats = {}

    def bump(gid, key):
        s = stats.setdefault(gid, {"valid": 0, "fp": 0, "malformed": 0, "fn": 0, "skipped": 0})
        s[key] += 1

    for label in ("valid", "malformed"):
        base = os.path.join(corpus, label)
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            fixture = os.path.join(base, name)
            if not os.path.isdir(fixture):
                continue
            for row in run_conform(fixture):
                gid = row["gate_id"]
                bucket = verdict_bucket(row)
                if bucket == "skip":
                    bump(gid, "skipped")
                    continue
                if label == "valid":
                    bump(gid, "valid")
                    if bucket == "flag":
                        bump(gid, "fp")
                else:
                    bump(gid, "malformed")
                    if bucket == "clean":
                        bump(gid, "fn")
    return stats


def rate(n, d):
    return (n / d) if d else 0.0


def main():
    ap = argparse.ArgumentParser(description="Measure gate FP/FN rate over a labeled corpus")
    ap.add_argument("--corpus", default=DEFAULT_CORPUS, help="labeled corpus root (valid/ + malformed/)")
    ap.add_argument("--json", action="store_true", help="emit JSON report to stdout")
    ap.add_argument("--max-fp-rate", type=float, default=None,
                    help="exit 1 if any measured gate's FP-rate exceeds this (promotion gate)")
    args = ap.parse_args()

    corpus = os.path.abspath(args.corpus)
    stats = measure(corpus)

    report = {}
    for gid, s in sorted(stats.items()):
        report[gid] = {
            "valid_samples": s["valid"],
            "false_positives": s["fp"],
            "fp_rate": round(rate(s["fp"], s["valid"]), 4),
            "malformed_samples": s["malformed"],
            "false_negatives": s["fn"],
            "fn_rate": round(rate(s["fn"], s["malformed"]), 4),
            "skipped_indeterminate": s["skipped"],
        }

    if args.json:
        print(json.dumps({"corpus": os.path.relpath(corpus, os.path.join(HERE, "..")),
                          "gates": report}, indent=2))
    else:
        print(f"FP/FN rate over corpus: {os.path.relpath(corpus, os.path.join(HERE, '..'))}")
        print(f"{'gate_id':<42} {'valid':>5} {'FP':>3} {'FP%':>6} {'malf':>4} {'FN':>3} {'FN%':>6}")
        for gid, r in report.items():
            print(f"{gid:<42} {r['valid_samples']:>5} {r['false_positives']:>3} "
                  f"{r['fp_rate']*100:>5.1f}% {r['malformed_samples']:>4} "
                  f"{r['false_negatives']:>3} {r['fn_rate']*100:>5.1f}%")
        if not report:
            print("  (no measurable gate verdicts in corpus)")

    if args.max_fp_rate is not None:
        over = {g: r["fp_rate"] for g, r in report.items() if r["fp_rate"] > args.max_fp_rate}
        if over:
            sys.stderr.write(f"\nfp-rate: {len(over)} gate(s) exceed --max-fp-rate={args.max_fp_rate}:\n")
            for g, fr in over.items():
                sys.stderr.write(f"  {g}: {fr:.4f}\n")
            sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
