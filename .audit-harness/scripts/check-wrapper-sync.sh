#!/usr/bin/env bash
# check-wrapper-sync.sh — assert the bundled wrapper-script mirrors are byte-identical
# to their canonical source under scripts/.
#
# WHY THIS EXISTS
# ---------------
# The Node package (bin/audit-harness.js) dispatches to the CANONICAL scripts under
# scripts/. The Python wrapper (intent-audit-harness on PyPI) and the Rust wrapper
# (intent-audit-harness on crates.io) cannot reach those canonical files at install
# time, so each BUNDLES a copy:
#
#   * python/src/intent_audit_harness/scripts/<name>   (packaged into the wheel)
#   * rust/scripts/<name>                              (include_bytes!'d into the binary)
#
# Those copies are hand-maintained. On 2026-05-24 they were found ~1 month stale:
# the bundled crap-score.py was missing v1.1.1's --json evidence envelope, the
# `which_or_none("go")` PATH guard (silent crash on Go-less hosts), and the
# rglob->os.walk directory pruning. A user running
# `pip install intent-audit-harness && audit-harness crap` got the OLD gate.
# (Tracking bead: iah-python-wrapper-scripts-sync / bd_000-projects-65k4.)
#
# This gate makes that class of drift IMPOSSIBLE to merge silently: every bundled
# mirror MUST be a byte-for-byte copy of its canonical source. There is no
# wrapper-only delta — both wrappers invoke the script verbatim via bash/python3.
#
# RESYNC (when this gate REDs)
# ----------------------------
#   bash scripts/check-wrapper-sync.sh --fix     # copy canonical -> both mirrors
# then review + commit the result.
#
# Exit codes:
#   0  all mirrors in sync (or --fix completed)
#   1  drift detected (and not in --fix mode)
set -euo pipefail

# Resolve repo root from this script's own location so the gate works regardless
# of the caller's CWD (CI runs it from the repo root; a dev may run it elsewhere).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CANONICAL_DIR="${REPO_ROOT}/scripts"

# The set of scripts the Python + Rust wrappers DISPATCH. Keep this in lock-step
# with:
#   * python/src/intent_audit_harness/cli.py     (COMMANDS dict)
#   * rust/src/main.rs                           (SCRIPTS array)
# If a wrapper starts dispatching a new canonical script, add it here AND to both
# wrapper sources, and copy it into both mirror dirs.
MIRRORED_SCRIPTS=(
  "harness-hash.sh"
  "escape-scan.sh"
  "arch-check.sh"
  "bias-count.sh"
  "gherkin-lint.sh"
  "crap-score.py"
)

# Each mirror directory that bundles a copy of the canonical scripts.
MIRROR_DIRS=(
  "python/src/intent_audit_harness/scripts"
  "rust/scripts"
)

FIX=0
if [[ "${1:-}" == "--fix" ]]; then
  FIX=1
fi

drift_found=0
missing_canonical=0

for name in "${MIRRORED_SCRIPTS[@]}"; do
  canonical="${CANONICAL_DIR}/${name}"
  if [[ ! -f "${canonical}" ]]; then
    echo "ERROR: canonical source missing: scripts/${name}" >&2
    missing_canonical=1
    continue
  fi
  for mdir in "${MIRROR_DIRS[@]}"; do
    mirror="${REPO_ROOT}/${mdir}/${name}"
    if [[ ! -f "${mirror}" ]]; then
      echo "DRIFT: missing mirror ${mdir}/${name} (expected a copy of scripts/${name})" >&2
      drift_found=1
      if [[ "${FIX}" -eq 1 ]]; then
        cp -f "${canonical}" "${mirror}"
        echo "  fixed: created ${mdir}/${name}"
      fi
      continue
    fi
    if ! diff -q "${canonical}" "${mirror}" >/dev/null 2>&1; then
      echo "DRIFT: ${mdir}/${name} differs from canonical scripts/${name}" >&2
      drift_found=1
      if [[ "${FIX}" -eq 1 ]]; then
        cp -f "${canonical}" "${mirror}"
        echo "  fixed: resynced ${mdir}/${name}"
      fi
    fi
  done
done

if [[ "${missing_canonical}" -eq 1 ]]; then
  echo "FAIL: one or more canonical scripts are missing — cannot verify mirror sync." >&2
  exit 1
fi

if [[ "${FIX}" -eq 1 ]]; then
  echo "check-wrapper-sync: --fix complete. Review + commit the resynced mirrors."
  exit 0
fi

if [[ "${drift_found}" -eq 1 ]]; then
  echo "" >&2
  echo "FAIL: bundled wrapper mirrors are out of sync with canonical scripts/." >&2
  echo "      The Python (PyPI) and Rust (crates.io) packages would ship STALE gates." >&2
  echo "      Resync with:  bash scripts/check-wrapper-sync.sh --fix" >&2
  echo "      then review + commit the result." >&2
  exit 1
fi

echo "check-wrapper-sync: OK — all ${#MIRRORED_SCRIPTS[@]} bundled mirrors match canonical in ${#MIRROR_DIRS[@]} wrapper dirs."
exit 0
