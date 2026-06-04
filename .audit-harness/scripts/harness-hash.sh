#!/usr/bin/env bash
# harness-hash.sh — SHA-256 manifest for engineer-owned artifacts.
#
# Pins .feature files and architecture rule configs. Any byte change to a
# pinned file without a fresh --init is treated as HARNESS_TAMPERED and
# causes escape-scan.sh to REFUSE the AI diff.
#
# Usage:
#   bash harness-hash.sh --init           # write manifest (engineer-initiated)
#   bash harness-hash.sh --verify         # compare current hashes to manifest
#   bash harness-hash.sh --verify --json  # machine-readable JSON to stdout (verify only)
#   bash harness-hash.sh --list           # show which files are pinned
#
# Exit codes:
#   0 — OK (pin matches, or init succeeded)
#   2 — HARNESS_TAMPERED (hash mismatch)
#   3 — no manifest found (--verify without --init)
#
# JSON mode:
#   stdout = single JSON object suitable for piping to `audit-harness emit-evidence`
#   stderr = unchanged human-readable summary (preserves backward-compat)
#   exit codes unchanged

set -euo pipefail

# Cross-platform SHA-256: `sha256sum` ships with GNU coreutils (Linux);
# macOS only has `shasum -a 256`. Both produce identical `<hash>  <file>`
# output, so downstream awk parsing is unchanged.
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD=(shasum -a 256)
else
  echo "harness-hash: neither sha256sum nor shasum found in PATH" >&2
  exit 2
fi

ROOT="${ROOT:-$(pwd)}"
MANIFEST="${ROOT}/.harness-hash"
JSON_OUT=0

# Peel --json from anywhere in args (additive, doesn't disturb existing arg shape)
_filtered_args=()
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=1 ;;
    *) _filtered_args+=("$arg") ;;
  esac
done
set -- "${_filtered_args[@]+"${_filtered_args[@]}"}"

PATTERNS=(
  # Wall 1: acceptance
  "features/**/*.feature"
  "features/*.feature"
  # Wall 7: architecture rule configs
  ".dependency-cruiser.js"
  ".dependency-cruiser.cjs"
  ".importlinter"
  "deptrac.yaml"
  "arch-go.yml"
  # Java ArchUnit tests
  "src/test/java/**/*ArchTest*.java"
  "src/test/java/**/*ArchitectureTest*.java"
  # .NET ArchTests
  "test/**/*ArchTests.cs"
  "tests/**/*ArchTests.cs"
  # Coverage thresholds (edits to these are escape attempts — hash them)
  ".c8rc.json"
  "stryker.conf.json"
  "stryker.config.js"
)

# Optional per-repo extra patterns appended from .harness-hash-extra-patterns
# at the repo root. Used by repos whose policy files don't match the default
# canonical patterns above — e.g., the audit-harness repo itself pins its own
# scripts (scripts/*.sh + scripts/*.py + bin/audit-harness.js), which are the
# policy enforcement surface but aren't covered by the consumer-facing
# defaults. Lines beginning with `#` are comments; blank lines are ignored.
# This mechanism is additive — repos without the file get exactly the
# default behavior, so consumer repos are not affected.
EXTRA_PATTERNS_FILE="${ROOT}/.harness-hash-extra-patterns"
if [[ -f "${EXTRA_PATTERNS_FILE}" ]]; then
  while IFS= read -r line || [[ -n "${line}" ]]; do
    # strip inline comments
    line="${line%%#*}"
    # trim leading + trailing whitespace
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" ]] && continue
    PATTERNS+=("${line}")
  done < "${EXTRA_PATTERNS_FILE}"
fi

collect_files() {
  local out=()
  shopt -s nullglob globstar
  for pattern in "${PATTERNS[@]}"; do
    for f in $pattern; do
      [[ -f "$f" ]] && out+=("$f")
    done
  done
  # de-dupe
  printf '%s\n' "${out[@]}" | sort -u
}

hash_files() {
  local files
  files=$(collect_files)
  if [[ -z "$files" ]]; then
    return 0
  fi
  while IFS= read -r f; do
    printf '%s  %s\n' "$("${SHA256_CMD[@]}" "$f" | awk '{print $1}')" "$f"
  done <<< "$files"
}

cmd_init() {
  cd "$ROOT"
  hash_files > "$MANIFEST"
  local count
  count=$(wc -l < "$MANIFEST" | tr -d ' ')
  echo "harness-hash: pinned $count file(s) → $MANIFEST"
}

cmd_verify() {
  cd "$ROOT"
  if [[ ! -f "$MANIFEST" ]]; then
    if [[ "$JSON_OUT" -eq 1 ]]; then
      printf '{"gate_id":"audit-harness:%s:harness-hash","result":"NOT_APPLICABLE","input_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","policy_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","metadata":{"reason":"no manifest at %s (run --init)"}}\n' \
        "${AUDIT_HARNESS_SIDE:-ci}" "$MANIFEST"
    fi
    echo "harness-hash: no manifest at $MANIFEST (run --init)" >&2
    exit 3
  fi
  local current
  current=$(hash_files)
  local expected
  expected=$(cat "$MANIFEST")

  local manifest_hash
  manifest_hash=$("${SHA256_CMD[@]}" "$MANIFEST" | awk '{print "sha256:"$1}')

  local pinned_count
  pinned_count=$(echo "$expected" | grep -c '^' || true)

  # Compare sorted manifests so order doesn't matter
  local diff_out
  diff_out=$(diff <(echo "$expected" | sort) <(echo "$current" | sort) || true)
  if [[ -z "$diff_out" ]]; then
    if [[ "$JSON_OUT" -eq 1 ]]; then
      printf '{"gate_id":"audit-harness:%s:harness-hash","result":"PASS","input_hash":"%s","policy_hash":"%s","metadata":{"pinned_count":%d}}\n' \
        "${AUDIT_HARNESS_SIDE:-ci}" "$manifest_hash" "$manifest_hash" "$pinned_count"
      echo "harness-hash: OK" >&2
    else
      echo "harness-hash: OK"
    fi
    exit 0
  fi
  if [[ "$JSON_OUT" -eq 1 ]]; then
    # diff output may contain quotes/newlines; encode as a single-line escaped string
    local diff_escaped
    diff_escaped=$(printf '%s' "$diff_out" | python3 -c 'import sys, json; print(json.dumps(sys.stdin.read()))')
    printf '{"gate_id":"audit-harness:%s:harness-hash","result":"FAIL","failure_mode":"HARNESS_TAMPERED","input_hash":"%s","policy_hash":"%s","metadata":{"pinned_count":%d,"diff":%s}}\n' \
      "${AUDIT_HARNESS_SIDE:-ci}" "$manifest_hash" "$manifest_hash" "$pinned_count" "$diff_escaped"
  fi
  echo "HARNESS_TAMPERED: pinned artifact changed" >&2
  echo "$diff_out" >&2
  exit 2
}

cmd_list() {
  cd "$ROOT"
  if [[ ! -f "$MANIFEST" ]]; then
    echo "harness-hash: no manifest (run --init)" >&2
    exit 3
  fi
  awk '{print $2}' "$MANIFEST"
}

case "${1:-}" in
  --init)   cmd_init ;;
  --verify) cmd_verify ;;
  --list)   cmd_list ;;
  --help|-h|*)
    sed -n '2,20p' "$0"
    exit 0
    ;;
esac
