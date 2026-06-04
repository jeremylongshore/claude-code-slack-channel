#!/usr/bin/env bash
# Quick test bias pattern counter
# Usage: bash bias-count.sh [test-directory] [--json]
#
# Scans test files for common bias patterns that weaken test suites.
# See references/test-quality-deep-audit.md Section 1 for full details.
#
# JSON mode:
#   stdout = single JSON object suitable for piping to `audit-harness emit-evidence`
#   stderr = unchanged human-readable summary (preserves backward-compat)
#   exit code unchanged (always 0; advisory gate)

set -euo pipefail

JSON_OUT=0
TEST_DIR="tests"

# Peel --json from anywhere; first non-flag positional is TEST_DIR.
_pos=()
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=1 ;;
    *) _pos+=("$arg") ;;
  esac
done
[[ "${#_pos[@]}" -gt 0 ]] && TEST_DIR="${_pos[0]}"

if [ ! -d "$TEST_DIR" ]; then
  if [[ "$JSON_OUT" -eq 1 ]]; then
    printf '{"gate_id":"audit-harness:%s:bias-count","result":"NOT_APPLICABLE","input_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","policy_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","metadata":{"reason":"test directory not found","path":"%s"}}\n' \
      "${AUDIT_HARNESS_SIDE:-ci}" "$TEST_DIR"
  fi
  echo "ERROR: Test directory '$TEST_DIR' not found" >&2
  echo "Usage: bash bias-count.sh [test-directory] [--json]" >&2
  exit 1
fi

# Hash the test directory tree as the "input"
INPUT_HASH=$(find "$TEST_DIR" -type f \( -name "*.py" -o -name "*.ts" -o -name "*.js" -o -name "*.tsx" -o -name "*.jsx" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.kt" -o -name "*.cs" -o -name "*.php" -o -name "*.rb" \) -exec sha256sum {} + 2>/dev/null | sort | sha256sum | awk '{print "sha256:"$1}')

if [[ "$JSON_OUT" -eq 1 ]]; then
  exec 3>&1   # save stdout for the JSON object
  exec 1>&2   # redirect human-readable to stderr
fi

echo "═══════════════════════════════════════"
echo "  TEST BIAS SCAN — $TEST_DIR"
echo "═══════════════════════════════════════"
echo

TOTAL_BIAS=0

count_pattern() {
  local label="$1"
  local pattern="$2"
  local count
  count=$(grep -rn "$pattern" "$TEST_DIR" 2>/dev/null | wc -l)
  TOTAL_BIAS=$((TOTAL_BIAS + count))
  printf "  %-30s %d\n" "$label" "$count"
}

echo "BIAS PATTERNS"
echo "─────────────────────────────────────"
count_pattern "Smoke-only (is not None)" "is not None$"
count_pattern "Smoke-only (assertIsNotNone)" "assertIsNotNone"
count_pattern "Smoke-only (toBeDefined)" "toBeDefined()"
count_pattern "Tautological (sorted==sorted)" "sorted.*==.*sorted"
count_pattern "Tautological (len==len)" "len.*==.*len"
count_pattern "Symmetric input (0,0)" "(0, 0)"
count_pattern "Symmetric input (1,1)" "(1, 1)"
count_pattern "Symmetric input (100,100)" "(100, 100)"
count_pattern "Range-only assertion" "assert.*<=.*<="
count_pattern 'Substring check (in str)' '" in '
echo

# Count test functions
TEST_COUNT=$(grep -rn "def test_\|it('\|it(\"\\|test('\|test(\"" "$TEST_DIR" 2>/dev/null | wc -l)

# Count total assertions
ASSERT_COUNT=$(grep -rn "assert\b\|assertEqual\|expect(" "$TEST_DIR" 2>/dev/null | wc -l)

# Assertion density
if [ "$TEST_COUNT" -gt 0 ]; then
  DENSITY=$(echo "scale=2; $ASSERT_COUNT / $TEST_COUNT" | bc)
else
  DENSITY="0"
fi

# Per-100 bias rate
if [ "$TEST_COUNT" -gt 0 ]; then
  RATE=$(echo "scale=1; $TOTAL_BIAS * 100 / $TEST_COUNT" | bc)
else
  RATE="0"
fi

echo "SUMMARY"
echo "─────────────────────────────────────"
printf "  %-30s %d\n" "Test functions" "$TEST_COUNT"
printf "  %-30s %d\n" "Total assertions" "$ASSERT_COUNT"
printf "  %-30s %s\n" "Assertion density" "$DENSITY per test"
printf "  %-30s %d\n" "Bias patterns found" "$TOTAL_BIAS"
printf "  %-30s %s\n" "Per-100-tests rate" "$RATE"
echo

# Grade
GRADE="LOW"
if [ "$(echo "$RATE <= 5" | bc)" -eq 1 ]; then
  GRADE="LOW"
  echo "  Grade: LOW — no action needed"
elif [ "$(echo "$RATE <= 15" | bc)" -eq 1 ]; then
  GRADE="MODERATE"
  echo "  Grade: MODERATE — review flagged tests"
elif [ "$(echo "$RATE <= 30" | bc)" -eq 1 ]; then
  GRADE="HIGH"
  echo "  Grade: HIGH — systematic remediation needed"
else
  GRADE="CRITICAL"
  echo "  Grade: CRITICAL — full rewrite of flagged tests"
fi
echo
echo "═══════════════════════════════════════"

if [[ "$JSON_OUT" -eq 1 ]]; then
  # Restore stdout for JSON emission
  exec 1>&3 3>&-
  # bias-count is advisory — never FAILs, severity rises with grade
  case "$GRADE" in
    LOW) sev="info" ;;
    MODERATE) sev="warn" ;;
    HIGH|CRITICAL) sev="error" ;;
  esac
  printf '{"gate_id":"audit-harness:%s:bias-count","result":"ADVISORY","advisory_severity":"%s","input_hash":"%s","policy_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","metadata":{"test_count":%d,"assertion_count":%d,"assertion_density":"%s","bias_total":%d,"per_100_rate":"%s","grade":"%s"}}\n' \
    "${AUDIT_HARNESS_SIDE:-ci}" "$sev" "$INPUT_HASH" "$TEST_COUNT" "$ASSERT_COUNT" "$DENSITY" "$TOTAL_BIAS" "$RATE" "$GRADE"
fi
