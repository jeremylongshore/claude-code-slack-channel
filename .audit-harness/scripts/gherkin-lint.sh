#!/usr/bin/env bash
# gherkin-lint.sh — Advisory Gherkin quality check for Wall 1.
#
# If gherkin-lint is installed (npm i -g gherkin-lint) it is used. Otherwise
# falls back to awk-based rubric checks for imperative verbs, CSS selectors
# in steps, missing Background, and overlong scenarios.
#
# Non-blocking by default (exit 0 on warnings). Use --strict to turn warnings
# into failures.
#
# Usage:
#   bash gherkin-lint.sh [--path features/] [--strict]

set -euo pipefail

PATH_ARG="features/"
STRICT=0
JSON_OUT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) PATH_ARG="$2"; shift 2 ;;
    --strict) STRICT=1; shift ;;
    --json) JSON_OUT=1; shift ;;
    --help|-h)
      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "gherkin-lint: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ ! -d "$PATH_ARG" ]]; then
  if [[ "$JSON_OUT" -eq 1 ]]; then
    printf '{"gate_id":"audit-harness:%s:gherkin-lint","result":"NOT_APPLICABLE","input_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","policy_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","metadata":{"reason":"path not found","path":"%s"}}\n' \
      "${AUDIT_HARNESS_SIDE:-ci}" "$PATH_ARG"
  fi
  echo "gherkin-lint: path not found: $PATH_ARG" >&2
  exit 2
fi

INPUT_HASH=$(find "$PATH_ARG" -name "*.feature" -type f -exec sha256sum {} \; 2>/dev/null | sort | sha256sum | awk '{print "sha256:"$1}')

if [[ "$JSON_OUT" -eq 1 ]]; then
  exec 3>&1
  exec 1>&2
fi

WARN_COUNT=0
ERROR_COUNT=0

warn() { echo "WARN  $1:$2 $3"; WARN_COUNT=$((WARN_COUNT + 1)); }

# process_awk_output — funnel awk-printed WARN/ERROR lines through the bash
# counters so the summary + exit code reflect awk-fallback findings (the
# subprocesses below can't otherwise touch the parent-shell counters).
# Single-pass awk counts both at once; no-match handled cleanly under
# set -euo pipefail via the `+0` numeric coercions.
process_awk_output() {
  local out="$1"
  [ -z "$out" ] && return 0
  local w=0 e=0
  read -r w e < <(awk '/^WARN /{w++} /^ERROR /{e++} END {print w+0, e+0}' <<< "$out")
  WARN_COUNT=$((WARN_COUNT + w))
  ERROR_COUNT=$((ERROR_COUNT + e))
  printf '%s\n' "$out"
}

# 1. Prefer official gherkin-lint if available
if command -v gherkin-lint >/dev/null 2>&1; then
  echo "gherkin-lint: using installed linter"
  if ! gherkin-lint "$PATH_ARG"; then
    ERROR_COUNT=1
  fi
else
  echo "gherkin-lint: falling back to awk rubric (install gherkin-lint for full rules)"

  while IFS= read -r -d '' feature; do
    # Imperative verbs / CSS selectors in steps (declarative warning)
    process_awk_output "$(awk -v file="$feature" '
      /^[[:space:]]*(Given|When|Then|And|But)/ {
        line = $0
        if (line ~ /click|type|fill[ _]in|press|select.*from[ _]dropdown/) {
          printf "WARN  %s:%d imperative verb in step (prefer declarative)\n", file, NR
        }
        if (line ~ /#[a-zA-Z][-a-zA-Z0-9_]*|\.[a-zA-Z][-a-zA-Z0-9_]*[[:space:]]|xpath/) {
          printf "WARN  %s:%d CSS selector / xpath in step (prefer business language)\n", file, NR
        }
      }
    ' "$feature")"

    # Scenario length (> 10 steps)
    process_awk_output "$(awk -v file="$feature" '
      /^[[:space:]]*Scenario/ { sc = NR; steps = 0; sn = $0; next }
      /^[[:space:]]*(Given|When|Then|And|But)/ { if (sc) steps++ }
      /^[[:space:]]*Scenario|^[[:space:]]*Feature|^$/ {
        if (sc && steps > 10) {
          printf "WARN  %s:%d scenario has %d steps (>10 is too long)\n", file, sc, steps
        }
        if (NR != sc) { sc = 0; steps = 0 }
      }
      END {
        if (sc && steps > 10) {
          printf "WARN  %s:%d scenario has %d steps (>10 is too long)\n", file, sc, steps
        }
      }
    ' "$feature")"

    # Repeated Givens without Background (3+ identical Given lines)
    dupe=$(awk '/^[[:space:]]*Given/ { print }' "$feature" | sort | uniq -c | awk '$1 >= 3 { print }')
    if [[ -n "$dupe" ]] && ! grep -q "^[[:space:]]*Background:" "$feature"; then
      warn "$feature" 0 "repeated Given lines without Background block"
    fi

    # "And" at scenario start (grammar error)
    process_awk_output "$(awk -v file="$feature" '
      /^[[:space:]]*Scenario/ { in_scenario = 1; step_count = 0; next }
      /^[[:space:]]*(Given|When|Then|And|But)/ {
        if (in_scenario && step_count == 0 && /^[[:space:]]*And/) {
          printf "ERROR %s:%d scenario starts with And (use Given/When/Then)\n", file, NR
        }
        step_count++
      }
    ' "$feature")"

  done < <(find "$PATH_ARG" -name "*.feature" -print0)
fi

echo ""
echo "gherkin-lint summary: $WARN_COUNT warning(s), $ERROR_COUNT error(s)"

if [[ "$JSON_OUT" -eq 1 ]]; then
  exec 1>&3 3>&-
  result="PASS"
  sev_block=""
  if [[ "$ERROR_COUNT" -gt 0 ]]; then
    result="FAIL"
  elif [[ "$WARN_COUNT" -gt 0 ]]; then
    if [[ "$STRICT" -eq 1 ]]; then
      result="FAIL"
    else
      result="ADVISORY"
      sev_block=',"advisory_severity":"warn"'
    fi
  fi
  printf '{"gate_id":"audit-harness:%s:gherkin-lint","result":"%s"%s,"input_hash":"%s","policy_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","metadata":{"warnings":%d,"errors":%d,"strict":%s,"path":"%s"}}\n' \
    "${AUDIT_HARNESS_SIDE:-ci}" "$result" "$sev_block" "$INPUT_HASH" "$WARN_COUNT" "$ERROR_COUNT" \
    "$([[ "$STRICT" -eq 1 ]] && echo true || echo false)" "$PATH_ARG"
fi

if [[ "$ERROR_COUNT" -gt 0 ]]; then
  exit 1
fi
if [[ "$STRICT" -eq 1 && "$WARN_COUNT" -gt 0 ]]; then
  exit 1
fi
exit 0
