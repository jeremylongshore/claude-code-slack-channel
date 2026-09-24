#!/usr/bin/env python3
"""
audit-harness currency — advisory poll-freshness report (PP-PLAN-040 Phase 5 / E7).

Currency depends on upstream state, which is non-deterministic and network-bound, so
it is deliberately the WEAKEST kind of check: an advisory REPORT with **no exit-code
authority, no auto-fix, and no live-fetch**. It reads the per-upstream-identity pin
relation (schemas/currency/pins.v1.json) — where each upstream carries its own
pinned_version + the date it was last verified (checked_at) + an advisory
poll-freshness SLA — and reports which pins are themselves PAST their SLA
(checked_at older than the SLA window), i.e. which pins a human should re-verify
against upstream. The SLA gates NOTHING except human attention.

This models the pin's OWN staleness as detectable, rather than one opaque
".schema-version" scalar. Pins are grouped by class (spec-page / schema-file /
release-feed / internal-contract); SLA resolution order is: explicit per-pin
staleness_window_days > the pin's class SLA > default_staleness_window_days.
The /sync-testing-harness skill consumes this report to open advisory bump PRs;
the report never reddens a build (always exit 0).

Follow-up (deliberately NOT wired here, [9k5h.10]): the intent-eval-lab
detector-health surface will consume the --json output; that cross-repo
integration is tracked separately.

Stdlib only. No network. No filesystem mutation.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PINS = os.path.join(HERE, "..", "schemas", "currency", "pins.v1.json")

UNCLASSED = "(unclassed)"


def parse_date(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None


def resolve_window(pin, classes, default_window):
    """SLA resolution: explicit per-pin window > class SLA > file default."""
    if pin.get("staleness_window_days") is not None:
        return pin["staleness_window_days"]
    cls = classes.get(pin.get("class") or "", {})
    if cls.get("staleness_window_days") is not None:
        return cls["staleness_window_days"]
    return default_window


def build_report(pins_doc, today):
    default_window = pins_doc.get("default_staleness_window_days", 90)
    classes = pins_doc.get("staleness_classes", {})
    out = []
    for pin in pins_doc.get("pins", []):
        checked = parse_date(pin.get("checked_at", ""))
        window = resolve_window(pin, classes, default_window)
        if checked is None:
            age, status = None, "unknown-checked_at"
        else:
            age = (today - checked).days
            status = "stale" if age > window else "current"
        out.append({
            "identity": pin.get("identity"),
            "class": pin.get("class") or UNCLASSED,
            "pinned_version": pin.get("pinned_version"),
            "checked_at": pin.get("checked_at"),
            "age_days": age,
            "window_days": window,
            "status": status,
            "source": pin.get("source"),
            "notes": pin.get("notes"),
        })
    return out


def group_by_class(report):
    """Ordered {class: [rows]} grouping, classes sorted, (unclassed) last."""
    grouped = {}
    for r in report:
        grouped.setdefault(r["class"], []).append(r)
    ordered = sorted(grouped, key=lambda c: (c == UNCLASSED, c))
    return {c: grouped[c] for c in ordered}


def main():
    ap = argparse.ArgumentParser(
        description="Advisory poll-freshness report (no exit authority — the SLA gates nothing but human attention)")
    ap.add_argument("--pins", default=DEFAULT_PINS, help="path to the pin relation datum")
    ap.add_argument("--json", action="store_true", help="emit JSON report")
    ap.add_argument("--today", default=None, help="override 'today' (YYYY-MM-DD) for reproducible reports/tests")
    args = ap.parse_args()

    pins_path = os.path.abspath(args.pins)
    try:
        with open(pins_path, "r", encoding="utf-8") as f:
            pins_doc = json.load(f)
    except Exception as e:
        sys.stderr.write(f"currency: cannot read pins at {pins_path}: {e}\n")
        sys.exit(2)

    today = parse_date(args.today) if args.today else datetime.now(timezone.utc).date()
    report = build_report(pins_doc, today)
    grouped = group_by_class(report)
    stale = [r for r in report if r["status"] == "stale"]
    unknown = [r for r in report if r["status"] == "unknown-checked_at"]

    if args.json:
        by_class = {}
        for cls, rows in grouped.items():
            by_class[cls] = {
                "total": len(rows),
                "stale": sum(1 for r in rows if r["status"] == "stale"),
                "current": sum(1 for r in rows if r["status"] == "current"),
                "unknown": sum(1 for r in rows if r["status"] == "unknown-checked_at"),
            }
        print(json.dumps({
            "report": "currency/v1",
            "generated_for": today.strftime("%Y-%m-%d"),
            "pins": report,
            "by_class": by_class,
            "stale_count": len(stale),
            "advisory": True,
        }, indent=2))
    else:
        print(f"Upstream currency — advisory poll-freshness SLA report — as of {today.strftime('%Y-%m-%d')}")
        print(f"{'identity':<26} {'pinned':<18} {'checked_at':<12} {'age':>5} {'sla':>4}  status")
        for cls, rows in grouped.items():
            print(f"[{cls}] — {len(rows)} pin(s)")
            for r in rows:
                age = "—" if r["age_days"] is None else str(r["age_days"]) + "d"
                if r["status"] == "stale":
                    mark = "⚠ PAST SLA"
                elif r["status"] == "current":
                    mark = "current"
                else:
                    mark = "? " + r["status"]
                print(f"  {(r['identity'] or ''):<24} {(r['pinned_version'] or ''):<18} "
                      f"{(r['checked_at'] or ''):<12} {age:>5} {r['window_days']:>4}  {mark}")
        print()
        if stale:
            print(f"{len(stale)} pin(s) past their poll-freshness SLA — the SLA gates nothing but human "
                  f"attention: re-verify against upstream, then bump pinned_version + checked_at in "
                  f"schemas/currency/pins.v1.json:")
            for r in stale:
                print(f"  - {r['identity']} [{r['class']}]: last checked {r['checked_at']} "
                      f"({r['age_days']}d ago > {r['window_days']}d SLA)")
        else:
            print("All pins within their poll-freshness SLA.")
        if unknown:
            print(f"{len(unknown)} pin(s) have an unparseable checked_at — fix the date format (YYYY-MM-DD).")

    # Advisory ONLY: never any exit-code authority. Always exit 0.
    sys.exit(0)


if __name__ == "__main__":
    main()
