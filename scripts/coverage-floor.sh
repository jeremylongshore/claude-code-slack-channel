#!/usr/bin/env bash
# Parse `bun test --coverage` output and fail if production-source line/func
# coverage drops below the floor. Bun 1.2.23 does not enforce coverageThreshold
# in bunfig.toml, so we gate on stdout here.
#
# "Production source" means every file row that does NOT start with "features/"
# (the Gherkin runner + step-definition glue is test-only infrastructure, not
# production code, so pulling it into the aggregate would misrepresent coverage).
# Coverage is computed as the average % across production files, matching the
# semantics of the original "All files" row before Gherkin step files were added.
#
# Usage: bash scripts/coverage-floor.sh [floor-percent]   (default 95)
set -euo pipefail

FLOOR="${1:-95}"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

bun test --coverage --timeout 15000 2>&1 | tee "$OUT"

# Row format (pipe-delimited, leading space + filename):
#   " <file>  |  <func%>  |  <line%>  | <uncovered>"
# Skip features/ rows (test-only glue), skip headers/separators/All-files.
# Compute average line% and func% across production files.
read -r LINE_COV FN_COV < <(awk '
  /^ features\// { next }
  /^[ \t]/ && /\|/ && !/% Funcs/ && !/All files/ && !/-{3}/ {
    n = split($0, a, "|")
    if (n >= 3) {
      sumFn   += a[2]+0
      sumLine += a[3]+0
      count++
    }
  }
  END {
    if (count > 0) printf "%.2f %.2f\n", sumLine/count, sumFn/count
    else            print "100 100"
  }
' "$OUT")

if [ -z "${LINE_COV:-}" ] || [ -z "${FN_COV:-}" ]; then
  echo "coverage-floor: could not parse coverage output" >&2
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
