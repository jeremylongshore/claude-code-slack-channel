#!/usr/bin/env bash
# Parse `bun test --coverage` output and fail if the All-files line % drops below the floor.
# Bun 1.2.23 does not enforce `coverageThreshold` in bunfig.toml, so we gate on stdout here.
#
# Usage: bash scripts/coverage-floor.sh [floor-percent]   (default 95)
set -euo pipefail

FLOOR="${1:-95}"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

bun test --coverage --timeout 15000 2>&1 | tee "$OUT"

LINE_COV=$(awk '/^All files/ {print $6}' "$OUT")
FN_COV=$(awk '/^All files/ {print $4}' "$OUT")

if [ -z "${LINE_COV:-}" ] || [ -z "${FN_COV:-}" ]; then
  echo "coverage-floor: could not parse coverage output (All files row missing)" >&2
  exit 1
fi

awk -v line="$LINE_COV" -v fn="$FN_COV" -v floor="$FLOOR" '
BEGIN {
  if (line+0 < floor+0) {
    printf "coverage-floor: line coverage %.2f%% below floor %s%%\n", line, floor > "/dev/stderr"
    exit 1
  }
  if (fn+0 < floor+0) {
    printf "coverage-floor: function coverage %.2f%% below floor %s%%\n", fn, floor > "/dev/stderr"
    exit 1
  }
  printf "coverage-floor: line=%s%% func=%s%% (floor=%s%%) OK\n", line, fn, floor
}
'
