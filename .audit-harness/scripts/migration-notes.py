#!/usr/bin/env python3
"""
audit-harness migration-notes — adopter-facing migration-notes generator (iah-E05d).

The fourth and final acceptance criterion of the SemVer regression epic (iah-E05):
"CLI surface snapshot ... breaking-change detector ... CI gate on un-versioned
breaking change ... migration-notes generator." The first three answer "did a
MAJOR-worthy change ship as MINOR/PATCH?" (tests/semver/run-semver-tests.sh).
THIS verb answers the adopter's downstream question: "I'm bumping
@intentsolutions/audit-harness across this version boundary — what, if anything,
do I have to change?"

Per 000-docs/012-AT-ARCH-repo-blueprint § 11.3 ("a MAJOR bump ships migration
notes in the release notes") this generator turns the two existing sources of
truth into a single migration document:

  1. CHANGELOG.md  — the Keep-a-Changelog release log (what changed, per version).
  2. SEMVER.md     — the breaking-change classification table + the stable-contract
                     freezes (exit codes, stream contracts, the predicate URI).

It is DETERMINISTIC and READ-ONLY (stdlib only, no network, no filesystem
mutation) — the same discipline as classify/conform/audit/scan/currency. It does
not invent migration steps; it surfaces the breaking-change-bearing sections that
already live in the release log and pairs them with the relevant SEMVER.md
"what we will never do" guarantees, so the notes are traceable to authored text
rather than model-fabricated advice.

Output modes:
  (default)  Markdown migration notes suitable for a release body or MIGRATION.md.
  --json     A machine-readable envelope (the same shape adopters can diff in CI).

Version selection:
  (no arg)        Notes for the latest released version in CHANGELOG.md.
  --from A --to B Notes spanning the (A, B] range of releases (A exclusive, B
                  inclusive) — the cumulative migration story across a multi-
                  version jump. --from may be omitted to mean "from the start".
  <version>       Positional shorthand for a single version's notes.

Exit codes:
  0  notes generated (whether or not they contain a breaking change)
  1  the requested version / range could not be resolved in CHANGELOG.md
  2  CHANGELOG.md not found or unparseable

Stdlib only. No network. No filesystem mutation.
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(HERE, ".."))
DEFAULT_CHANGELOG = os.path.join(REPO_ROOT, "CHANGELOG.md")
DEFAULT_SEMVER = os.path.join(REPO_ROOT, "SEMVER.md")

# A Keep-a-Changelog version header: "## [1.2.0] - 2026-06-15" (date optional,
# "Unreleased" tolerated and skipped). Capture the bracketed version + the rest.
VERSION_HEADER_RE = re.compile(
    r"^##\s+\[(?P<version>[^\]]+)\]\s*(?:-\s*(?P<date>.+?))?\s*$"
)
SECTION_HEADER_RE = re.compile(r"^###\s+(?P<name>.+?)\s*$")
SEMVER_TRIPLE_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)")


def parse_semver(v):
    """Return (major, minor, patch) for sorting/diffing, or None if not a triple."""
    m = SEMVER_TRIPLE_RE.match(v.strip())
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def classify_bump(prev, cur):
    """Given two (M,m,p) tuples, classify the bump as major/minor/patch/unknown.

    `prev` may be None (cur is the first release) -> 'initial'.
    """
    if cur is None:
        return "unknown"
    if prev is None:
        return "initial"
    if cur[0] != prev[0]:
        return "major"
    if cur[1] != prev[1]:
        return "minor"
    if cur[2] != prev[2]:
        return "patch"
    return "none"


def parse_changelog(text):
    """Parse Keep-a-Changelog text into an ordered list of release records.

    Each record: {version, date, summary, sections: {name: [lines...]}, raw}.
    The "Unreleased" section is skipped (not a released boundary an adopter pins).
    Order is as-written (newest first, the Keep-a-Changelog convention).
    """
    lines = text.splitlines()
    releases = []
    cur = None
    cur_section = None

    def flush():
        nonlocal cur, cur_section
        if cur is not None:
            releases.append(cur)
        cur = None
        cur_section = None

    for line in lines:
        vh = VERSION_HEADER_RE.match(line)
        if vh:
            flush()
            version = vh.group("version").strip()
            if version.lower() == "unreleased":
                # Skip the Unreleased buffer — it is not a pinnable boundary.
                cur = None
                continue
            cur = {
                "version": version,
                "date": (vh.group("date") or "").strip(),
                "summary": [],
                "sections": {},
                "raw": [line],
            }
            cur_section = None
            continue
        if cur is None:
            continue
        cur["raw"].append(line)
        sh = SECTION_HEADER_RE.match(line)
        if sh:
            cur_section = sh.group("name").strip()
            cur["sections"].setdefault(cur_section, [])
            continue
        if cur_section is None:
            # Pre-first-### prose is the release summary (incl. the "> Why ..."
            # blockquote that authors use to justify the bump level).
            if line.strip():
                cur["summary"].append(line.rstrip())
        else:
            cur["sections"][cur_section].append(line.rstrip())

    flush()
    return releases


def parse_semver_doc(text):
    """Extract the breaking-change classification rows + the 'never do' list.

    Returns {"major_rules": [str...], "never_do": [str...]}. Both are best-effort
    and purely advisory context for the notes — absence degrades gracefully to an
    empty list rather than failing.
    """
    major_rules = []
    never_do = []
    in_never = False
    for line in text.splitlines():
        stripped = line.strip()
        # TL;DR classification table rows whose Semver-impact cell says **major**.
        if stripped.startswith("|") and "major" in stripped.lower():
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if len(cells) >= 2 and "major" in cells[-1].lower():
                change = cells[0].strip()
                if change and change.lower() != "change":
                    major_rules.append(change)
        if stripped.lower().startswith("## what we will never do"):
            in_never = True
            continue
        if in_never:
            if stripped.startswith("## "):
                in_never = False
                continue
            if stripped.startswith("- "):
                never_do.append(stripped[2:].strip())
    return {"major_rules": major_rules, "never_do": never_do}


# Section names that, when present in a release, are the ones an adopter must
# read on a MAJOR boundary. "Removed" and "Changed" carry the breaking surface;
# "Added" is additive and never forces a migration. We surface them in priority
# order.
ACTION_SECTIONS = ("Removed", "Changed", "Deprecated")


def select_releases(releases, args):
    """Resolve the requested version selection into the ordered release subset.

    Returns (subset, error_message). subset is newest-first like `releases`.
    """
    by_version = {r["version"]: r for r in releases}

    if args.version:
        r = by_version.get(args.version)
        if r is None:
            return None, f"version '{args.version}' not found in CHANGELOG.md"
        return [r], None

    if args.to or args.from_:
        # Resolve a (from, to] range. Default `to` to the latest release.
        to_v = args.to or (releases[0]["version"] if releases else None)
        if to_v is None:
            return None, "no releases found in CHANGELOG.md"
        if to_v not in by_version:
            return None, f"--to version '{to_v}' not found in CHANGELOG.md"
        if args.from_ and args.from_ not in by_version:
            return None, f"--from version '{args.from_}' not found in CHANGELOG.md"
        # Reject an inverted range up front: `from` must be strictly older than
        # `to` (the range is the versions you cross going from -> to). Releases
        # are newest-first, so `from` must appear LATER in the list than `to`.
        if args.from_:
            order = [r["version"] for r in releases]
            if order.index(args.from_) <= order.index(to_v):
                return None, (
                    f"inverted range: --from '{args.from_}' is not older than "
                    f"--to '{to_v}' (you upgrade FROM the older version TO the newer)"
                )
        # Releases are newest-first; walk until we pass `to`, collect until `from`.
        subset = []
        collecting = False
        for r in releases:
            if r["version"] == to_v:
                collecting = True
            if collecting:
                if args.from_ and r["version"] == args.from_:
                    break  # from is exclusive
                subset.append(r)
        if not subset:
            return None, f"empty range (--from '{args.from_}' --to '{to_v}')"
        return subset, None

    # Default: the latest released version.
    if not releases:
        return None, "no releases found in CHANGELOG.md"
    return [releases[0]], None


def annotate_bumps(all_releases, subset):
    """Attach a bump classification to each release in `subset`.

    The predecessor of a release is the next-older release in the full ordered
    list, so a single-version request still classifies major/minor/patch.
    """
    order = [r["version"] for r in all_releases]
    idx = {v: i for i, v in enumerate(order)}
    annotated = []
    for r in subset:
        i = idx.get(r["version"])
        prev_v = order[i + 1] if (i is not None and i + 1 < len(order)) else None
        cur = parse_semver(r["version"])
        prev = parse_semver(prev_v) if prev_v else None
        bump = classify_bump(prev, cur)
        annotated.append({
            "release": r,
            "prev_version": prev_v,
            "bump": bump,
            "breaking": bump in ("major",),
        })
    return annotated


def build_envelope(annotated, semver_ctx, args):
    """Assemble the machine-readable migration-notes envelope."""
    any_breaking = any(a["breaking"] for a in annotated)
    versions = []
    for a in annotated:
        r = a["release"]
        action_sections = {
            name: r["sections"].get(name, [])
            for name in ACTION_SECTIONS
            if r["sections"].get(name)
        }
        versions.append({
            "version": r["version"],
            "date": r["date"],
            "prev_version": a["prev_version"],
            "bump": a["bump"],
            "breaking": a["breaking"],
            "summary": "\n".join(r["summary"]).strip(),
            "action_required_sections": action_sections,
            "all_sections": list(r["sections"].keys()),
        })
    return {
        "schema": "migration-notes/v1",
        "package": "@intentsolutions/audit-harness",
        "selection": {
            "version": args.version,
            "from": args.from_,
            "to": args.to,
        },
        "any_breaking": any_breaking,
        "versions": versions,
        "semver_context": {
            "major_change_rules": semver_ctx["major_rules"],
            "never_do": semver_ctx["never_do"],
            "semver_doc": "SEMVER.md",
        },
    }


def render_markdown(envelope):
    """Render the envelope as adopter-facing Markdown migration notes."""
    out = []
    versions = envelope["versions"]
    if len(versions) == 1:
        title_scope = versions[0]["version"]
    else:
        newest = versions[0]["version"]
        oldest = versions[-1]["version"]
        title_scope = f"{oldest} → {newest}"
    out.append(f"# Migration notes — `@intentsolutions/audit-harness` {title_scope}")
    out.append("")
    if envelope["any_breaking"]:
        out.append(
            "> **Action may be required.** This boundary crosses at least one "
            "**MAJOR** version bump. Read the breaking-change sections below before "
            "upgrading pinned CI / pre-commit calls."
        )
    else:
        out.append(
            "> **No action required.** Every version in this boundary is an "
            "additive **minor** or a **patch**. Existing pre-commit hooks and CI "
            "calls keep working unchanged (per the `^0.x`/`^1.x` adopter guarantee "
            "in `SEMVER.md`)."
        )
    out.append("")

    for v in versions:
        header = f"## {v['version']}"
        if v["date"]:
            header += f" — {v['date']}"
        out.append(header)
        out.append("")
        bump_label = {
            "major": "**MAJOR** (breaking — migration required)",
            "minor": "**minor** (additive — opt-in, no migration)",
            "patch": "**patch** (fix-only — no migration)",
            "initial": "**initial** release",
            "none": "no version change",
            "unknown": "unclassified bump",
        }.get(v["bump"], v["bump"])
        prev = f" from `{v['prev_version']}`" if v["prev_version"] else ""
        out.append(f"- **Bump:** {bump_label}{prev}")
        out.append("")

        if v["summary"]:
            # Strip the "> Why ..." blockquote markers for clean inline prose but
            # keep the authored justification — it explains the bump level.
            summary = v["summary"]
            out.append(summary)
            out.append("")

        if v["breaking"]:
            if v["action_required_sections"]:
                out.append("### What changed (read before upgrading)")
                out.append("")
                for name, items in v["action_required_sections"].items():
                    body = "\n".join(items).strip()
                    if body:
                        out.append(f"**{name}:**")
                        out.append("")
                        out.append(body)
                        out.append("")
            else:
                out.append(
                    "_No `Removed`/`Changed`/`Deprecated` section recorded for this "
                    "release — review the full CHANGELOG entry and `SEMVER.md` "
                    "before upgrading._"
                )
                out.append("")

    # Append the SEMVER.md context only when a breaking boundary is in scope —
    # adopters crossing a major need to know what the package guarantees it will
    # NOT silently do.
    if envelope["any_breaking"]:
        ctx = envelope["semver_context"]
        if ctx["major_change_rules"]:
            out.append("---")
            out.append("")
            out.append("## What counts as a breaking change (from `SEMVER.md`)")
            out.append("")
            for rule in ctx["major_change_rules"]:
                out.append(f"- {rule}")
            out.append("")
        if ctx["never_do"]:
            out.append("## Stability guarantees (`SEMVER.md` — “what we will never do”)")
            out.append("")
            for item in ctx["never_do"]:
                out.append(f"- {item}")
            out.append("")

    return "\n".join(out).rstrip() + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="audit-harness migration-notes",
        description="Generate adopter-facing migration notes from CHANGELOG.md + SEMVER.md.",
    )
    parser.add_argument(
        "version",
        nargs="?",
        help="A single version to generate notes for (e.g. 1.2.0). "
             "Omit for the latest release, or use --from/--to for a range.",
    )
    parser.add_argument(
        "--from",
        dest="from_",
        metavar="VERSION",
        help="Range start (exclusive). The version you are upgrading FROM.",
    )
    parser.add_argument(
        "--to",
        dest="to",
        metavar="VERSION",
        help="Range end (inclusive). The version you are upgrading TO. "
             "Defaults to the latest release.",
    )
    parser.add_argument(
        "--changelog",
        default=DEFAULT_CHANGELOG,
        help="Path to CHANGELOG.md (default: repo CHANGELOG.md).",
    )
    parser.add_argument(
        "--semver",
        default=DEFAULT_SEMVER,
        help="Path to SEMVER.md (default: repo SEMVER.md).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a machine-readable migration-notes/v1 envelope instead of Markdown.",
    )
    args = parser.parse_args(argv)

    if not os.path.isfile(args.changelog):
        print(
            f"migration-notes: CHANGELOG.md not found at {args.changelog}",
            file=sys.stderr,
        )
        return 2
    try:
        with open(args.changelog, encoding="utf-8") as fh:
            changelog_text = fh.read()
    except OSError as exc:
        print(f"migration-notes: cannot read {args.changelog}: {exc}", file=sys.stderr)
        return 2

    releases = parse_changelog(changelog_text)
    if not releases:
        print(
            "migration-notes: no released versions parsed from CHANGELOG.md",
            file=sys.stderr,
        )
        return 2

    semver_ctx = {"major_rules": [], "never_do": []}
    if os.path.isfile(args.semver):
        try:
            with open(args.semver, encoding="utf-8") as fh:
                semver_ctx = parse_semver_doc(fh.read())
        except OSError:
            pass  # SEMVER.md context is advisory; degrade gracefully.

    subset, err = select_releases(releases, args)
    if err:
        print(f"migration-notes: {err}", file=sys.stderr)
        return 1

    annotated = annotate_bumps(releases, subset)
    envelope = build_envelope(annotated, semver_ctx, args)

    if args.json:
        json.dump(envelope, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(render_markdown(envelope))
    return 0


if __name__ == "__main__":
    sys.exit(main())
