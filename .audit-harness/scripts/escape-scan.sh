#!/usr/bin/env bash
# escape-scan.sh — detect AI escape attempts in a proposed diff.
#
# Scans a unified diff (from git or a patch file) for patterns that indicate
# the AI is trying to lower a wall instead of meeting the bar.
#
# Severity grammar:
#   FLAG      → logged, does not halt (printed on stderr)
#   CHALLENGE → require engineer-approved reason (exit 1)
#   REFUSE    → halt the pipeline (exit 2)
#
# Exit codes:
#   0 — clean
#   1 — CHALLENGE (at least one must-challenge pattern matched)
#   2 — REFUSE (at least one refuse pattern matched, or hash mismatch)
#
# Usage:
#   git diff | bash escape-scan.sh -
#   bash escape-scan.sh path/to/change.patch
#   bash escape-scan.sh --staged          # git diff --cached
#   bash escape-scan.sh --range HEAD~1..HEAD
#   bash escape-scan.sh --staged --json   # machine-readable JSON to stdout
#
# JSON mode:
#   stdout = single JSON object suitable for piping to `audit-harness emit-evidence`
#   stderr = unchanged human-readable [SEVERITY] notes (preserves backward-compat)
#   exit codes unchanged

set -euo pipefail

# Bash version floor: these gates rely on bash 4+ features. Refuse early with a
# clear message on bash 3.x (e.g. macOS system bash) instead of failing later
# with a cryptic syntax error (jcgw).
[ "${BASH_VERSINFO:-0}" -ge 4 ] || { echo 'audit-harness requires bash >= 4' >&2; exit 3; }

# Cross-platform SHA-256: `sha256sum` ships with GNU coreutils (Linux);
# macOS only has `shasum -a 256`. Both produce identical `<hash>  <file>`
# output, so downstream awk parsing is unchanged. Mirrors harness-hash.sh.
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD=(shasum -a 256)
else
  echo "escape-scan: neither sha256sum nor shasum found in PATH" >&2
  exit 2
fi

DIFF_SRC=""
VERIFY_HASH=1
JSON_OUT=0
ROOT="${ROOT:-$(pwd)}"
HASH_SCRIPT="$(dirname "$0")/harness-hash.sh"

# First-pass arg parse: peel --json off the tail (any position) so primary
# arg parsing below is unchanged.
_filtered_args=()
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=1 ;;
    *) _filtered_args+=("$arg") ;;
  esac
done
set -- "${_filtered_args[@]+"${_filtered_args[@]}"}"

if [[ "$#" -eq 0 ]]; then
  echo "escape-scan: pass a diff source (- for stdin, --staged, --range, or a patch file)" >&2
  exit 2
fi

case "$1" in
  -)
    # Buffer stdin into a temp file so the diff can be read multiple times.
    # /dev/stdin is drained by the first grep, which would leave later reads
    # (notably the input_hash sha256) seeing an empty stream — emitting the
    # SHA-256 of "" instead of the real diff hash.
    DIFF_SRC=$(mktemp)
    trap 'rm -f "$DIFF_SRC"' EXIT
    cat > "$DIFF_SRC"
    ;;
  --staged)
    DIFF_SRC=$(mktemp)
    trap 'rm -f "$DIFF_SRC"' EXIT
    git diff --cached > "$DIFF_SRC"
    ;;
  --range)
    DIFF_SRC=$(mktemp)
    trap 'rm -f "$DIFF_SRC"' EXIT
    git diff "$2" > "$DIFF_SRC"
    shift
    ;;
  --no-hash) VERIFY_HASH=0; shift; DIFF_SRC="$1" ;;
  --help|-h)
    sed -n '2,26p' "$0"; exit 0 ;;
  *) DIFF_SRC="$1" ;;
esac

if [[ ! -r "$DIFF_SRC" ]]; then
  echo "escape-scan: cannot read $DIFF_SRC" >&2
  exit 2
fi

REFUSE=0
CHALLENGE=0
FLAG=0

# --- Load floor thresholds from tests/TESTING.md (fallback to defaults) ---
# Reads canonical thresholds so audits enforce the repo's policy, not a
# hardcoded script-level guess. Format expected in TESTING.md (policy section):
#   coverage.line: 80
#   coverage.branch: 70
#   mutation.kill_rate: 70
COVERAGE_LINE_FLOOR=80
COVERAGE_BRANCH_FLOOR=70
MUTATION_FLOOR=70
TESTING_MD="$ROOT/tests/TESTING.md"
# The `|| true` on each lookup is LOAD-BEARING, not defensive noise. Under
# `set -euo pipefail` a grep that matches nothing makes the whole command
# substitution non-zero, and `set -e` then killed this script MID-LOAD — before
# a single check ran, with no output, exiting 1. Exit 1 is the documented code
# for CHALLENGE, so a repo whose tests/TESTING.md omitted any one of these three
# keys got ZERO escape scanning while appearing to merely warn. That is a
# silent, total bypass of the gate; a blatant `fail_under` set to 5 sailed through.
# Same reason for the trailing `|| true` on each guarded assignment: a false
# `[[ -n ]]` test is the last command in an && list and would trip `set -e` too.
policy_value() {
  local raw
  raw=$(grep -Ei "^[[:space:]]*$1[[:space:]]*:" "$TESTING_MD" 2>/dev/null \
    | head -1 | sed -E 's/.*:[[:space:]]*([0-9]+).*/\1/' || true)
  # The sed leaves the line UNCHANGED when it holds no number, so a typo like
  # `coverage.line: eighty` used to become the "floor". Every later comparison
  # then died on `[[: invalid arithmetic operator ]]` and the scan finished
  # REFUSE=0 exit 0 — a fail-OPEN that let a blatant lowered threshold through.
  # Anything non-numeric is discarded here so the built-in default stands.
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    printf '%s' "$raw"
  else
    [[ -n "$raw" ]] && echo "[FLAG] tests/TESTING.md: ${1//\\/} is not a number — using the built-in default" >&2
    printf ''
  fi
}
if [[ -f "$TESTING_MD" ]]; then
  v=$(policy_value 'coverage\.line')
  if [[ -n "$v" ]]; then COVERAGE_LINE_FLOOR="$v"; fi
  v=$(policy_value 'coverage\.branch')
  if [[ -n "$v" ]]; then COVERAGE_BRANCH_FLOOR="$v"; fi
  v=$(policy_value 'mutation\.kill_rate')
  if [[ -n "$v" ]]; then MUTATION_FLOOR="$v"; fi
fi

# Collect only added lines (prefix + but not +++)
added_lines=$(grep -E '^\+[^+]' "$DIFF_SRC" || true)
file_headers=$(grep -E '^\+\+\+ ' "$DIFF_SRC" || true)

note() {
  local severity="$1" msg="$2"
  echo "[$severity] $msg" >&2
  case "$severity" in
    REFUSE) REFUSE=$((REFUSE + 1)) ;;
    CHALLENGE) CHALLENGE=$((CHALLENGE + 1)) ;;
    FLAG) FLAG=$((FLAG + 1)) ;;
  esac
}

# --- REFUSE: coverage threshold edits ---
# Floor is policy-driven (tests/TESTING.md coverage.line). Any explicit
# threshold lower than the floor is an escape attempt.
check_below_floor() {
  local line="$1" floor="$2"
  local n
  n=$(printf '%s\n' "$line" | grep -oE '[0-9]+' | head -1 || true)
  [[ -n "$n" ]] && [[ "$n" -lt "$floor" ]]
}

# Coverage-threshold keys, checked PER KEY rather than "first number on the line".
#
# Two bugs this replaces:
#   1. The old pattern required DOUBLE-QUOTED keys ("lines":<N>), so it caught
#      package.json but missed jest.config.js — `lines:<N>` unquoted, which is
#      the standard JS-config shape and the most common Jest form there is.
#   2. It compared only the FIRST number on the line, so
#      `{ branches:<hi>, lines:<lo> }` tested the FIRST value, passed, and never looked at the second.
#      That one bit the quoted form too — the "working" case was also broken.
#
# Quotes are now optional — BOTH kinds. `'lines': 50` is valid JS and was still
# slipping through a double-quote-only class, which is a one-character evasion.
# EVERY key:value pair on the line is tested, not just the first. The left
# boundary keeps `max_lines:<N>` from matching the `lines` key.
# Case-sensitive on purpose: Jest keys are lowercase, so `LINES:` is not a
# working config and therefore not a successful escape.
# A bare `lines: 3` is a coverage threshold ONLY inside a coverage config. In
# ordinary source it is just an object key, and making quotes optional turned
# `const x = { lines: 3 }` into a REFUSE — a false positive that would block
# honest commits, which is worse than the gap it closed. A threshold written
# anywhere else has no effect on coverage and therefore cannot be an escape, so
# scoping to these filenames loses no real detection.
is_coverage_config() {
  case "${1##*/}" in
    jest.config.*|vitest.config.*|karma.conf.*|nyc.config.*|jest.setup.*) return 0 ;;
    package.json|.nycrc|.nycrc.*|.c8rc|.c8rc.*) return 0 ;;
    .coveragerc|setup.cfg|pyproject.toml|pytest.ini|tox.ini) return 0 ;;
  esac
  return 1
}

check_coverage_keys_below_floor() {
  local line="$1" floor="$2" pair n
  while IFS= read -r pair; do
    [[ -z "$pair" ]] && continue
    n="${pair##*:}"; n="${n//[^0-9]/}"
    if [[ -n "$n" ]] && [[ "$n" -lt "$floor" ]]; then return 0; fi
  done < <(printf '%s\n' "$line" \
      | grep -oE "(^|[^A-Za-z0-9_])[\"']?(branches|lines|functions|statements)[\"']?[[:space:]]*:[[:space:]]*[0-9]+" \
      || true)
  return 1
}
while IFS= read -r line; do
  if [[ "$line" =~ fail_under[[:space:]]*=[[:space:]]*[0-9] ]] || [[ "$line" =~ --cov-fail-under=[0-9] ]]; then
    if check_below_floor "$line" "$COVERAGE_LINE_FLOOR"; then
      note REFUSE "coverage fail_under lowered below policy floor ($COVERAGE_LINE_FLOOR) — escape attempt"
    fi
  fi
done <<< "$added_lines"

# Coverage-key thresholds are checked PER FILE (see is_coverage_config above),
# so this pass walks the diff with path context rather than the flat line list.
while IFS=$'\t' read -r cpath cline; do
  [[ -z "$cpath" ]] && continue
  is_coverage_config "$cpath" || continue
  if check_coverage_keys_below_floor "$cline" "$COVERAGE_LINE_FLOOR"; then
    note REFUSE "coverageThreshold in $cpath lowered below policy floor ($COVERAGE_LINE_FLOOR) — escape attempt"
  fi
done < <(awk '
  /^\+\+\+ / { p=$2; sub(/^b\//,"",p); next }
  /^\+[^+]/   { if (p != "" && p != "/dev/null") print p "\t" substr($0,2) }
' "$DIFF_SRC" || true)
if echo "$added_lines" | grep -Eq 'coverageThreshold[[:space:]]*:[[:space:]]*0'; then
  note REFUSE "coverageThreshold set to 0 (escape attempt)"
fi
if echo "$added_lines" | grep -Eq 'minimum[[:space:]]*=[[:space:]]*0\.[0-7]'; then
  note REFUSE "JaCoCo minimum lowered (escape attempt)"
fi

# --- REFUSE: architecture bypasses ---
if echo "$added_lines" | grep -Eq 'depcruise-disable|@ArchIgnore|skip_violations|ignore_imports[[:space:]]*=|severity[[:space:]]*:[[:space:]]*"warn"'; then
  note REFUSE "architecture rule bypass (depcruise-disable / @ArchIgnore / skip_violations / ignore_imports / severity downgrade)"
fi

# --- REFUSE: wholesale test deletion (file headers only) ---
# Detect deleted test files with no compensating additions
deleted_tests=$(grep -E '^--- a/.*test.*|^--- a/.*spec.*' "$DIFF_SRC" | grep -v 'test.*\.md$' || true)
added_tests=$(echo "$file_headers" | grep -E '\+\+\+ b/.*test.*|\+\+\+ b/.*spec.*' || true)
if [[ -n "$deleted_tests" && -z "$added_tests" ]]; then
  note REFUSE "test file(s) deleted without compensating additions"
fi

# --- REFUSE: .feature file mutation (hash check) ---
if [[ "$VERIFY_HASH" -eq 1 && -f "$ROOT/.harness-hash" && -x "$HASH_SCRIPT" ]]; then
  if ! (cd "$ROOT" && bash "$HASH_SCRIPT" --verify >/dev/null 2>&1); then
    note REFUSE "HARNESS_TAMPERED — pinned .feature or rule-config file changed"
  fi
fi
# Also REFUSE if the diff itself touches .feature files
if echo "$file_headers" | grep -Eq '\+\+\+ b/.*\.feature'; then
  note REFUSE ".feature file modified (human-owned artifact)"
fi

# --- CHALLENGE: test skip markers ---
if echo "$added_lines" | grep -Eq '@pytest\.mark\.skip|\.skip\(|\.only\(|@Ignore\b|@Disabled\b|@SkipTest\b'; then
  note CHALLENGE "test skip marker added (requires engineer-approved reason)"
fi

# --- CHALLENGE: mutation bypass markers ---
if echo "$added_lines" | grep -Eq 'pragma:[[:space:]]*no[[:space:]]*mutate|Stryker[[:space:]]*disable|@DoNotMutate'; then
  note CHALLENGE "mutation bypass marker added"
fi

# --- CHALLENGE: assertion weakening (diff-aware) ---
# Look at removed+added pairs: old was a strong assertion, new is weak
# Heuristic: new line contains assertTrue(True) / toBeDefined() / is not None
if echo "$added_lines" | grep -Eq 'assertTrue\(True\)|assertEquals\(true,[[:space:]]*true\)'; then
  note CHALLENGE "trivially-true assertion added (assertTrue(True) equivalent)"
fi

# --- FLAG: weak-assertion patterns (informational) ---
if echo "$added_lines" | grep -Eq 'toBeDefined\(\)|\.is not None'; then
  note FLAG "smoke-only assertion pattern (consider tightening)"
fi

# --- Summary & exit ---
if [[ "$JSON_OUT" -eq 1 ]]; then
  # Result mapping (per intent-eval-lab evidence-bundle SPEC § 5 R6):
  #   any REFUSE → FAIL
  #   any CHALLENGE (no REFUSE) → FAIL  (exit 1 = blocking, requires human)
  #   only FLAG → ADVISORY (exit 0 — informational)
  #   none → PASS
  result="PASS"
  if [[ "$REFUSE" -gt 0 || "$CHALLENGE" -gt 0 ]]; then
    result="FAIL"
  elif [[ "$FLAG" -gt 0 ]]; then
    result="ADVISORY"
  fi
  input_hash=$("${SHA256_CMD[@]}" "$DIFF_SRC" | awk '{print "sha256:"$1}')
  policy_hash="sha256:0000000000000000000000000000000000000000000000000000000000000000"
  if [[ -f "$TESTING_MD" ]]; then
    policy_hash=$("${SHA256_CMD[@]}" "$TESTING_MD" | awk '{print "sha256:"$1}')
  fi
  printf '{"gate_id":"audit-harness:%s:escape-scan","result":"%s","input_hash":"%s","policy_hash":"%s","metadata":{"refuse":%d,"challenge":%d,"flag":%d,"coverage_line_floor":%d,"coverage_branch_floor":%d,"mutation_floor":%d}' \
    "${AUDIT_HARNESS_SIDE:-ci}" "$result" "$input_hash" "$policy_hash" "$REFUSE" "$CHALLENGE" "$FLAG" \
    "$COVERAGE_LINE_FLOOR" "$COVERAGE_BRANCH_FLOOR" "$MUTATION_FLOOR"
  if [[ "$result" == "ADVISORY" ]]; then
    printf ',"advisory_severity":"info"'
  fi
  printf '}\n'
  echo "escape-scan: REFUSE=$REFUSE CHALLENGE=$CHALLENGE FLAG=$FLAG" >&2
else
  echo "escape-scan: REFUSE=$REFUSE CHALLENGE=$CHALLENGE FLAG=$FLAG"
fi
if [[ "$REFUSE" -gt 0 ]]; then
  echo "escape-scan: pipeline halted (REFUSE)" >&2
  exit 2
fi
if [[ "$CHALLENGE" -gt 0 ]]; then
  echo "escape-scan: pipeline needs engineer approval (CHALLENGE)" >&2
  exit 1
fi
exit 0
