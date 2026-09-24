#!/usr/bin/env bash
# cred-gate.sh — Provider credential PASS/FAIL gate (iah-E08).
#
# CISO non-negotiable per DR-010 S1Q5: before any provider abstraction is allowed
# to flow data into an Evidence Bundle / OTel signal / gate-result envelope, two
# things MUST hold and are gated here, deterministically and offline:
#
#   1. CREDENTIAL REDACTION — no provider secret VALUE appears verbatim in the
#      candidate artifact (the JSON the runner is about to sign, the OTel line it
#      is about to emit, any log it captures). A leaked API key in a signed,
#      Rekor-anchored Statement is irreversible.
#
#   2. ENV-VAR SPILLOVER — the candidate artifact does not blindly serialize the
#      process environment (e.g. an `env` dump, a `process.env` spread, or a
#      "context": {<all env>} block). A provider key need not be named to leak:
#      a wholesale env dump spills every secret at once.
#
# This gate is READ-ONLY and OFFLINE. It never contacts a provider, never reads
# a real key from disk, and never writes. It inspects the candidate artifact you
# hand it (stdin or --input) against the secret values present in the environment
# (referenced by NAME via --secret-env, so the values never appear on the command
# line) plus a built-in catalog of provider-key SHAPES.
#
# It emits a gate-result/v1 envelope on stdout (--json) suitable for piping to
# emit-evidence, OR a human-readable PASS/FAIL summary (default).
#
# Usage:
#   bash cred-gate.sh --input candidate.json
#   <producer> | bash cred-gate.sh                      # candidate on stdin
#   bash cred-gate.sh --secret-env ANTHROPIC_API_KEY --secret-env OPENAI_API_KEY < cand.json
#   bash cred-gate.sh --json < candidate.json | bash emit-evidence.sh
#
# Flags:
#   --input PATH       Read the candidate artifact from PATH instead of stdin.
#   --secret-env NAME  Treat $NAME's VALUE as a secret that must NOT appear in the
#                      candidate. Repeatable. The value is read from the
#                      environment by name — it is never passed on argv.
#   --json             Emit a gate-result/v1 envelope (JSON) instead of text.
#   --gate-id ID       Override the gate_id in the envelope (default: provider-cred-gate).
#   --help, -h         Print help.
#
# Exit codes:
#   0 — PASS (no secret value present; no env-var spillover detected)
#   1 — FAIL (a secret value leaked OR an env-var spillover pattern matched)
#   2 — usage / input error (no candidate, unreadable --input)
#
# Failure-mode docs (iah-E08d): see docs/cred-gate.md for the catalog of detected
# shapes, the spillover heuristics, the false-positive posture, and remediation.

set -euo pipefail

# Bash version floor: align with the rest of the harness (jcgw).
[ "${BASH_VERSINFO:-0}" -ge 4 ] || { echo 'audit-harness requires bash >= 4' >&2; exit 2; }

INPUT="-"
EMIT_JSON=0
GATE_ID="provider-cred-gate"
SECRET_ENVS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)       INPUT="$2"; shift 2 ;;
    --secret-env)  SECRET_ENVS+=("$2"); shift 2 ;;
    --json)        EMIT_JSON=1; shift ;;
    --gate-id)     GATE_ID="$2"; shift 2 ;;
    --help|-h)     sed -n '2,46p' "$0"; exit 0 ;;
    *) echo "cred-gate: unknown flag $1" >&2; exit 2 ;;
  esac
done

# --- Read the candidate artifact ---
if [[ "$INPUT" == "-" ]]; then
  CANDIDATE=$(cat)
else
  if [[ ! -r "$INPUT" ]]; then
    echo "cred-gate: cannot read $INPUT" >&2
    exit 2
  fi
  CANDIDATE=$(cat "$INPUT")
fi

if [[ -z "$CANDIDATE" ]]; then
  echo "cred-gate: empty candidate artifact" >&2
  exit 2
fi

# Resolve the gate input hash (sha256 of the candidate bytes) so the emitted
# envelope's input_hash is coherent with what was actually inspected.
INPUT_HASH="sha256:$(printf '%s' "$CANDIDATE" | sha256sum | cut -d' ' -f1)"
# The policy is this script's own bytes — a content address of the gate logic.
POLICY_HASH="sha256:$(sha256sum "$0" | cut -d' ' -f1)"

# --- Collect the secret VALUES to redaction-check (by env-var name) ---
# Built as a NUL-delimited blob so values with newlines/spaces stay intact and
# never touch argv.
SECRET_VALUES_BLOB=""
for name in "${SECRET_ENVS[@]:-}"; do
  [[ -z "$name" ]] && continue
  # Indirect expansion: read $name's value without it ever appearing on argv.
  val="${!name:-}"
  # Skip empty / trivially short values: a 1-char "secret" would false-positive
  # on virtually any artifact and is not a real credential.
  [[ ${#val} -lt 8 ]] && continue
  SECRET_VALUES_BLOB+="$val"$'\0'
done

# --- Deterministic analysis in python (offline; values via env, not argv) ---
# We pass the candidate + the secret blob + the catalog knobs through the
# environment so no secret value is ever visible in `ps`.
RESULT=$(
  CANDIDATE="$CANDIDATE" \
  SECRET_VALUES_BLOB="$SECRET_VALUES_BLOB" \
  GATE_ID="$GATE_ID" \
  python3 - <<'PY'
import json
import os
import re
import sys

candidate = os.environ["CANDIDATE"]

findings = []  # list of {"kind": ..., "detail": ...}

# --- 1. Credential redaction: explicit secret VALUES must not appear verbatim ---
blob = os.environ.get("SECRET_VALUES_BLOB", "")
secret_values = [v for v in blob.split("\0") if v]
for val in secret_values:
    if val in candidate:
        # NEVER echo the secret. Report only its length + a non-reversible
        # fingerprint so the finding is actionable without re-leaking.
        import hashlib

        fp = hashlib.sha256(val.encode("utf-8")).hexdigest()[:12]
        findings.append(
            {
                "kind": "secret-value-leak",
                "detail": (
                    "a declared secret value (len=%d, sha256:%s...) appears "
                    "verbatim in the candidate artifact" % (len(val), fp)
                ),
            }
        )

# --- 2. Credential redaction: provider-key SHAPES (value-agnostic catalog) ---
# Each pattern matches the literal on-the-wire shape of a known provider key.
# A match means a raw key is embedded even if it was not declared via
# --secret-env. Patterns are intentionally specific to keep the FP rate low.
SHAPE_PATTERNS = [
    ("anthropic-key", r"sk-ant-[A-Za-z0-9_-]{20,}"),
    # OpenAI keys start sk- but NOT sk-ant- (that's anthropic, matched above).
    # The negative lookahead keeps the two findings disjoint.
    ("openai-key", r"sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}"),
    ("groq-key", r"gsk_[A-Za-z0-9]{20,}"),
    ("nvidia-key", r"nvapi-[A-Za-z0-9_-]{20,}"),
    ("aws-access-key-id", r"AKIA[0-9A-Z]{16}"),
    ("google-api-key", r"AIza[0-9A-Za-z_-]{35}"),
    ("github-token", r"gh[posru]_[A-Za-z0-9]{36,}"),
    ("slack-token", r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    ("private-key-block", r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
]
for name, pattern in SHAPE_PATTERNS:
    if re.search(pattern, candidate):
        findings.append(
            {
                "kind": "secret-shape-match",
                "detail": "candidate contains a value matching the %s key shape"
                % name,
            }
        )

# --- 3. Env-var spillover: wholesale environment serialization ---
# A provider key need not be NAMED to leak — a blanket env dump spills every
# secret at once. We flag the structural patterns that serialize the whole
# environment into the artifact.
SPILLOVER_PATTERNS = [
    ("process-env-spread", r"\.\.\.\s*process\.env\b"),
    ("os-environ-dump", r"\bdict\(\s*os\.environ\s*\)|\bos\.environ\b\s*[,}\]]"),
    ("env-block-key", r'"(?:env|environ|environment)"\s*:\s*\{'),
    ("printenv-capture", r"\b(?:printenv|/usr/bin/env)\b"),
]
# These are heuristics: matching one is an ADVISORY-grade structural smell, but
# combined with an actual secret leak it is a hard FAIL. We treat any spillover
# match as a finding so the gate FAILs — an env dump in a to-be-signed artifact
# is exactly the irreversible leak this gate exists to stop.
for name, pattern in SPILLOVER_PATTERNS:
    if re.search(pattern, candidate):
        findings.append(
            {
                "kind": "env-spillover",
                "detail": "candidate serializes the process environment via "
                "the %s pattern" % name,
            }
        )

result = "FAIL" if findings else "PASS"
print(json.dumps({"result": result, "findings": findings}))
PY
)

# --- Parse the python result ---
GATE_RESULT=$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['result'])")
FINDINGS_JSON=$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['findings']))")
FINDING_COUNT=$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['findings']))")

# --- Emit ---
if [[ "$EMIT_JSON" -eq 1 ]]; then
  GATE_ID="$GATE_ID" GATE_RESULT="$GATE_RESULT" INPUT_HASH="$INPUT_HASH" \
  POLICY_HASH="$POLICY_HASH" FINDINGS_JSON="$FINDINGS_JSON" \
  python3 - <<'PY'
import json
import os

env = {
    "gate_id": os.environ["GATE_ID"],
    "result": os.environ["GATE_RESULT"],
    "input_hash": os.environ["INPUT_HASH"],
    "policy_hash": os.environ["POLICY_HASH"],
    "metadata": {"findings": json.loads(os.environ["FINDINGS_JSON"])},
}
if env["result"] == "FAIL":
    env["failure_mode"] = "provider_credential_leak"
print(json.dumps(env, separators=(",", ":")))
PY
else
  if [[ "$GATE_RESULT" == "PASS" ]]; then
    echo "cred-gate: PASS — no provider secret value present, no env-var spillover detected"
  else
    echo "cred-gate: FAIL — $FINDING_COUNT credential finding(s):" >&2
    printf '%s' "$FINDINGS_JSON" | python3 -c "
import json, sys
for f in json.load(sys.stdin):
    sys.stderr.write('  ⛔ [%s] %s\n' % (f['kind'], f['detail']))
"
    echo "cred-gate: see docs/cred-gate.md for remediation (iah-E08d)." >&2
  fi
fi

[[ "$GATE_RESULT" == "PASS" ]] && exit 0 || exit 1
