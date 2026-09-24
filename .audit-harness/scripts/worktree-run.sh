#!/usr/bin/env bash
# worktree-run.sh — run the deterministic gate set in a disposable git worktree
# BEFORE a push leaves the machine, so CI becomes confirmation, not discovery.
#
# Extracted from the no-mistakes discovery (2026-08-30): the one idea worth
# keeping from that tool is closing the gate loop pre-push in an isolated
# worktree. Everything else about it (LLM review stage, auto-fix authority,
# proxy push) is deliberately NOT here. This runner has:
#   - NO push authority (it never touches a remote)
#   - NO LLM stage (every gate is an exit code)
#   - NO writes to the repo (rows go to a temp file or --out; the worktree is
#     disposable and removed on exit)
#
# Gate set (same checks CI runs, resolved per repo):
#   verify       harness-hash --verify in the worktree   fail-closed (exit 2)
#   escape-scan  --range <remote>..<local>               fail-closed (exit 1/2)
#   conform      conform.py (advisory rows)              never raises exit
#   audit        audit.py --fast (advisory rows)         never raises exit
#
# The advisory gates emit gate-result/v1 rows for evidence; only the two
# already-promoted fail-closed gates (verify, escape-scan) can block a push,
# per docs/gate-promotion.md. Promotion of the advisory rows to blocking goes
# through the measured FP ≤5% + engineer-pin path, never through this script.
#
# Usage:
#   bash worktree-run.sh --pre-push          # as a git/lefthook pre-push hook
#   bash worktree-run.sh --ref <REF>         # gate an arbitrary ref (default HEAD)
#   bash worktree-run.sh --range A..B        # explicit escape-scan range
#   bash worktree-run.sh ... --out FILE      # write gate-result rows to FILE
#
# In --pre-push mode the git pre-push stdin protocol
# (<local-ref> <local-sha> <remote-ref> <remote-sha> per line) is consumed if
# present; when stdin is empty (lefthook may drain it) the range falls back to
# merge-base with the upstream or origin/HEAD.
#
# Exit codes (mirrors escape-scan/verify):
#   0 — clean (advisory findings do not change the exit code)
#   1 — CHALLENGE (escape-scan)
#   2 — REFUSE (escape-scan) or HARNESS_TAMPERED (verify)

set -euo pipefail

[ "${BASH_VERSINFO:-0}" -ge 4 ] || { echo 'audit-harness requires bash >= 4' >&2; exit 3; }

# Kill-switch: same lever every gate honors.
if [[ "${AUDIT_HARNESS_DISABLE:-0}" == "1" ]]; then
  echo "worktree-run: AUDIT_HARNESS_DISABLE=1 — skipping (no gates run)" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"

REF="HEAD"
RANGE=""
OUT=""
PRE_PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pre-push) PRE_PUSH=1; shift ;;
    --ref)      REF="$2"; shift 2 ;;
    --range)    RANGE="$2"; shift 2 ;;
    --out)      OUT="$2"; shift 2 ;;
    *) echo "worktree-run: unknown arg: $1" >&2; exit 3 ;;
  esac
done

ZEROS="0000000000000000000000000000000000000000"

if [[ "$PRE_PUSH" == "1" ]]; then
  # git pre-push stdin: <local-ref> <local-sha> <remote-ref> <remote-sha>
  # Take the first non-delete line. `read -t` so a drained/absent stdin
  # (lefthook, manual invocation) falls through instead of hanging.
  while read -r -t 1 _lref lsha _rref rsha; do
    [[ "$lsha" == "$ZEROS" ]] && continue   # branch deletion — nothing to gate
    REF="$lsha"
    if [[ "$rsha" != "$ZEROS" ]]; then RANGE="${rsha}..${lsha}"; fi
    break
  done || true
fi

SHA="$(git rev-parse --verify "${REF}^{commit}")"

if [[ -z "$RANGE" ]]; then
  # New branch or no stdin: scan everything since the fork point.
  BASE="$(git merge-base "$SHA" '@{upstream}' 2>/dev/null \
       || git merge-base "$SHA" origin/HEAD 2>/dev/null \
       || true)"
  if [[ -n "$BASE" && "$BASE" != "$SHA" ]]; then RANGE="${BASE}..${SHA}"; fi
fi

[[ -n "$OUT" ]] || OUT="$(mktemp -t worktree-run-rows.XXXXXX)"

# ---- disposable worktree ----------------------------------------------------
WT_PARENT="$(mktemp -d -t worktree-run.XXXXXX)"
WT="$WT_PARENT/wt"
cleanup() {
  # shellcheck disable=SC2317  # invoked via the EXIT trap
  git -C "$REPO_ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
  # shellcheck disable=SC2317
  rm -rf "$WT_PARENT"
}
trap cleanup EXIT
git -C "$REPO_ROOT" worktree add --detach --quiet "$WT" "$SHA"

WORST=0
raise() { local ec=$1; if (( ec > WORST )); then WORST=$ec; fi; }

TMP_ROWS="$WT_PARENT/rows"
mkdir -p "$TMP_ROWS"

# ---- gate 1: verify (fail-closed) -------------------------------------------
vec=0
(cd "$WT" && bash "$SCRIPT_DIR/harness-hash.sh" --verify) >&2 || vec=$?
case "$vec" in
  0) echo "worktree-run: verify PASS" >&2 ;;
  3) echo "worktree-run: verify SKIP (no .harness-hash manifest at $SHA)" >&2 ;;
  *) echo "worktree-run: verify FAIL — HARNESS_TAMPERED at $SHA" >&2; raise 2 ;;
esac

# ---- gate 2: escape-scan on the push range (fail-closed) --------------------
eec=0
if [[ -n "$RANGE" ]]; then
  # Run inside the worktree so the hash verification and diff both see the
  # tree being pushed; the worktree shares the object database, so range
  # refs resolve identically.
  (cd "$WT" && bash "$SCRIPT_DIR/escape-scan.sh" --range "$RANGE" --json) \
    > "$TMP_ROWS/escape-scan.json" || eec=$?
  case "$eec" in
    0) echo "worktree-run: escape-scan PASS ($RANGE)" >&2 ;;
    1) echo "worktree-run: escape-scan CHALLENGE ($RANGE)" >&2; raise 1 ;;
    *) echo "worktree-run: escape-scan REFUSE ($RANGE)" >&2; raise 2 ;;
  esac
else
  echo "worktree-run: escape-scan SKIP (no range resolvable for $SHA)" >&2
fi

# ---- gates 3+4: conform + audit (advisory — never raise the exit code) ------
python3 "$SCRIPT_DIR/conform.py" "$WT" > "$TMP_ROWS/conform.json" 2>/dev/null \
  || echo "worktree-run: conform INDETERMINATE (advisory)" >&2
python3 "$SCRIPT_DIR/audit.py" --fast "$WT" > "$TMP_ROWS/audit.json" 2>/dev/null \
  || echo "worktree-run: audit INDETERMINATE (advisory)" >&2

# ---- assemble gate-result/v1 rows -------------------------------------------
python3 - "$TMP_ROWS" "$OUT" <<'PY'
import json, pathlib, sys
rows_dir, out = pathlib.Path(sys.argv[1]), sys.argv[2]
rows = []
for f in sorted(rows_dir.glob("*.json")):
    try:
        data = json.loads(f.read_text())
    except (json.JSONDecodeError, OSError):
        continue
    rows.extend(data if isinstance(data, list) else [data])
pathlib.Path(out).write_text(json.dumps(rows, indent=2) + "\n")
print(f"worktree-run: {len(rows)} gate-result rows -> {out}", file=sys.stderr)
PY

if (( WORST == 0 )); then
  echo "worktree-run: CLEAN — safe to push $SHA" >&2
else
  echo "worktree-run: BLOCKED (exit $WORST) — fix or get an engineer-approved reason; do not weaken the gate" >&2
fi
exit "$WORST"
