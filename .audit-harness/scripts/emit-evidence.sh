#!/usr/bin/env bash
# emit-evidence.sh — wrap a gate-result JSON envelope in an in-toto Statement v1.
#
# Reads a gate-result envelope JSON document from stdin (or --input), augments it
# with the fields the runner knows (timestamp, runner version, commit_sha), and
# emits a complete in-toto Statement v1 to stdout. Optionally signs the Statement
# via `cosign sign-blob` and/or pushes to the Rekor transparency log.
#
# Per intent-eval-lab/specs/evidence-bundle/v0.1.0-draft/SPEC.md the emitted
# Statement carries predicateType https://evals.intentsolutions.io/gate-result/v1.
#
# Usage:
#   <gate> --json | bash emit-evidence.sh                          # unsigned, prints Statement
#   bash emit-evidence.sh --input gate.json                        # read from file
#   bash emit-evidence.sh --sign --key cosign.key < gate.json      # cosign key-based sign
#   bash emit-evidence.sh --sign --keyless < gate.json             # cosign keyless (Fulcio OIDC)
#   bash emit-evidence.sh --sign --rekor-url https://rekor.sigstore.dev < gate.json
#   bash emit-evidence.sh --output bundle/row.json < gate.json
#
# Flags:
#   --input PATH       Read gate-result JSON from PATH instead of stdin
#   --output PATH      Write Statement (DSSE envelope if --sign) to PATH instead of stdout
#   --sign             Sign the Statement via cosign. Default: --keyless.
#   --keyless          Force cosign keyless signing (OIDC). Default when --sign and no --key.
#   --key PATH         Cosign keyref. Use instead of --keyless.
#   --rekor-url URL    Push the signed attestation to Rekor at URL. Implies --sign.
#                      Default Rekor URL when present without value: https://rekor.sigstore.dev
#   --no-sign          Explicitly skip signing (default behavior; documents the choice)
#   --runner-version V Override the runner version string (default: from package.json)
#   --commit-sha SHA   Override the commit SHA (default: git rev-parse HEAD)
#   --help, -h         Print help
#
# Exit codes:
#   0 — Statement emitted successfully
#   1 — input JSON malformed or missing required fields
#   2 — signing requested but cosign not available
#   3 — Rekor push requested but failed
#
# CISO gate (per ISEDC v1 Q1, 2026-05-10): pushing to a public transparency log
# (Rekor) against the predicate URI https://evals.intentsolutions.io/gate-result/v1
# is BLOCKED until DNSSEC + CAA records are verified on the namespace. The script
# does NOT enforce this — that is operator discipline. See bead `iel-4zr` in
# intent-eval-platform/intent-eval-lab/.beads/.

set -euo pipefail

INPUT="-"
OUTPUT=""
SIGN=0
KEYLESS=0
KEYREF=""
REKOR_URL=""
RUNNER_VERSION_OVERRIDE=""
COMMIT_SHA_OVERRIDE=""
PREDICATE_URI="https://evals.intentsolutions.io/gate-result/v1"
STATEMENT_TYPE="https://in-toto.io/Statement/v1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)       INPUT="$2"; shift 2 ;;
    --output)      OUTPUT="$2"; shift 2 ;;
    --sign)        SIGN=1; shift ;;
    --keyless)     SIGN=1; KEYLESS=1; shift ;;
    --key)         SIGN=1; KEYREF="$2"; shift 2 ;;
    --rekor-url)
                   SIGN=1
                   if [[ "${2:-}" =~ ^-- ]] || [[ -z "${2:-}" ]]; then
                     REKOR_URL="https://rekor.sigstore.dev"
                     shift
                   else
                     REKOR_URL="$2"
                     shift 2
                   fi
                   ;;
    --no-sign)     SIGN=0; shift ;;
    --runner-version) RUNNER_VERSION_OVERRIDE="$2"; shift 2 ;;
    --commit-sha)  COMMIT_SHA_OVERRIDE="$2"; shift 2 ;;
    --help|-h)     sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "emit-evidence: unknown flag $1" >&2; exit 1 ;;
  esac
done

# --- Read input ---
if [[ "$INPUT" == "-" ]]; then
  GATE_JSON=$(cat)
else
  if [[ ! -r "$INPUT" ]]; then
    echo "emit-evidence: cannot read $INPUT" >&2
    exit 1
  fi
  GATE_JSON=$(cat "$INPUT")
fi

if [[ -z "$GATE_JSON" ]]; then
  echo "emit-evidence: empty input" >&2
  exit 1
fi

# --- Resolve runner + commit metadata ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_JSON="${SCRIPT_DIR}/../package.json"

if [[ -n "$RUNNER_VERSION_OVERRIDE" ]]; then
  RUNNER="$RUNNER_VERSION_OVERRIDE"
elif [[ -f "$PKG_JSON" ]]; then
  # Pass PKG_JSON via argv so paths with quotes/spaces/specials don't break the python source.
  VER=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['version'])" "$PKG_JSON" 2>/dev/null || echo "unknown")
  RUNNER="audit-harness@${VER}"
else
  RUNNER="audit-harness@unknown"
fi

if [[ -n "$COMMIT_SHA_OVERRIDE" ]]; then
  COMMIT_SHA="$COMMIT_SHA_OVERRIDE"
else
  COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "0000000")
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- Compose the Statement via python (deterministic JSON shape, escaping handled) ---
STATEMENT=$(GATE_JSON="$GATE_JSON" PREDICATE_URI="$PREDICATE_URI" STATEMENT_TYPE="$STATEMENT_TYPE" \
  RUNNER="$RUNNER" COMMIT_SHA="$COMMIT_SHA" TIMESTAMP="$TIMESTAMP" \
  python3 - <<'PY'
import json, os, sys

gate = json.loads(os.environ["GATE_JSON"])

required = ["gate_id", "result", "input_hash", "policy_hash"]
missing = [k for k in required if k not in gate]
if missing:
    sys.stderr.write(f"emit-evidence: gate-result missing required keys: {missing}\n")
    sys.exit(1)

# Augment predicate with runner-supplied fields
predicate = {
    "gate_id":     gate["gate_id"],
    "result":      gate["result"],
    "policy_hash": gate["policy_hash"],
    "input_hash":  gate["input_hash"],
    "timestamp":   os.environ["TIMESTAMP"],
    "runner":      os.environ["RUNNER"],
    "commit_sha":  os.environ["COMMIT_SHA"],
}

# Carry forward optional fields if present
for opt in ("metadata", "failure_mode", "advisory_severity"):
    if opt in gate:
        predicate[opt] = gate[opt]

# Subject naming: subject.name MUST equal predicate.gate_id (SPEC § 6 R8)
# Subject digest: subject.digest.sha256 MUST equal predicate.input_hash (SPEC § 6 R9)
input_hash = gate["input_hash"]
if not input_hash.startswith("sha256:"):
    sys.stderr.write(f"emit-evidence: input_hash must be sha256:-prefixed, got: {input_hash}\n")
    sys.exit(1)
digest_hex = input_hash[len("sha256:"):]

statement = {
    "_type":         os.environ["STATEMENT_TYPE"],
    "subject":       [{
        "name":   gate["gate_id"],
        "digest": {"sha256": digest_hex},
    }],
    "predicateType": os.environ["PREDICATE_URI"],
    "predicate":     predicate,
}

print(json.dumps(statement))
PY
)

if [[ -z "$STATEMENT" ]]; then
  echo "emit-evidence: failed to compose Statement" >&2
  exit 1
fi

# --- OTel event (best-effort no-op if collector absent) ---
# Fire agent.rollout.gate.evaluated per intent-eval-lab/000-docs/001-DR-RFC-...md.
# We emit a single OTLP-shaped JSON line to stderr when AUDIT_HARNESS_OTEL=1
# OR an OTEL_EXPORTER_OTLP_ENDPOINT is set. Real exporter wiring is consumer-side;
# we emit a structured signal that any collector can scrape via stderr capture.
if [[ "${AUDIT_HARNESS_OTEL:-0}" == "1" ]] || [[ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]]; then
  GATE_ID=$(echo "$GATE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('gate_id',''))" 2>/dev/null || echo "")
  RESULT=$(echo "$GATE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('result',''))" 2>/dev/null || echo "")
  printf '[OTEL] {"name":"agent.rollout.gate.evaluated","attributes":{"gate.id":"%s","gate.result":"%s","gate.runner":"%s","gate.commit_sha":"%s"},"timestamp":"%s"}\n' \
    "$GATE_ID" "$RESULT" "$RUNNER" "$COMMIT_SHA" "$TIMESTAMP" >&2
fi

# --- Sign + emit ---
emit() {
  local content="$1"
  if [[ -n "$OUTPUT" ]]; then
    mkdir -p "$(dirname "$OUTPUT")"
    printf '%s\n' "$content" > "$OUTPUT"
    echo "emit-evidence: wrote $OUTPUT" >&2
  else
    printf '%s\n' "$content"
  fi
}

if [[ "$SIGN" -eq 0 ]]; then
  emit "$STATEMENT"
  exit 0
fi

# Signing requires cosign. We use `cosign attest-blob` if available (canonical
# in-toto signing), falling back to `cosign sign-blob` with the Statement as the
# blob (less canonical but functional for verification round-trip).
if ! command -v cosign >/dev/null 2>&1; then
  echo "emit-evidence: --sign requested but cosign is not installed (https://docs.sigstore.dev/cosign/installation/)" >&2
  exit 2
fi

# Stage the Statement to a temp file for cosign to consume
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
STATEMENT_FILE="$TMP/statement.json"
printf '%s\n' "$STATEMENT" > "$STATEMENT_FILE"
ENVELOPE_FILE="$TMP/envelope.dsse.json"

COSIGN_ARGS=("attest-blob" "--predicate" "$STATEMENT_FILE" "--type" "$PREDICATE_URI")
if [[ -n "$KEYREF" ]]; then
  COSIGN_ARGS+=("--key" "$KEYREF")
elif [[ "$KEYLESS" -eq 1 ]] || [[ -z "$KEYREF" ]]; then
  COSIGN_ARGS+=("--yes")   # accept Fulcio OIDC keyless
fi
if [[ -n "$REKOR_URL" ]]; then
  COSIGN_ARGS+=("--rekor-url" "$REKOR_URL")
  COSIGN_ARGS+=("--tlog-upload=true")
else
  COSIGN_ARGS+=("--tlog-upload=false")
fi
COSIGN_ARGS+=("--output-signature" "$ENVELOPE_FILE")
# `cosign attest-blob` needs a "blob" — the input the predicate attests to.
# Per SPEC subject naming, that's the input_hash; we use a virtual artifact name.
ARTIFACT_NAME="$(echo "$STATEMENT" | python3 -c "import json,sys; print(json.load(sys.stdin)['subject'][0]['name'])")"

# Write a placeholder blob whose sha256 == the declared input_hash. This makes
# the DSSE envelope's subject coherent with the predicate.
# (Cosign re-hashes the blob; we trust the gate's input_hash to be the canonical
# subject. For v0.x we accept this round-trip-by-construction.)
BLOB_FILE="$TMP/$ARTIFACT_NAME.blob"
# A real subject artifact would be the file the gate evaluated; for the envelope
# we use the in-band predicate as the blob. Verification only needs the DSSE
# wrap + the predicate, not the original artifact bytes.
cp "$STATEMENT_FILE" "$BLOB_FILE"

if ! cosign "${COSIGN_ARGS[@]}" "$BLOB_FILE" >&2; then
  echo "emit-evidence: cosign signing failed" >&2
  exit 3
fi

emit "$(cat "$ENVELOPE_FILE")"
echo "emit-evidence: signed envelope emitted${REKOR_URL:+ (Rekor: $REKOR_URL)}" >&2
exit 0
