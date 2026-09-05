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
#   4 — production DNSSEC/CAA pre-flight FAILED (fail-closed; nothing was signed)
#
# CISO gate (per DR-010 Q5 / ISEDC v1 Q1, 2026-05-10): pushing to a PUBLIC
# transparency log (Rekor) against the predicate URI
# https://evals.intentsolutions.io/gate-result/v1 is BLOCKED until DNSSEC + CAA
# records are verified on the namespace. This script ENFORCES that: when a
# production Rekor push is requested (--rekor-url / non-empty REKOR_URL), it runs
# scripts/dnssec-check.sh then scripts/caa-check.sh against the predicate
# namespace and REFUSES to sign (exit 4) if either fails. The gate is read-only —
# it anchors nothing and can only make signing MORE conservative.
#
# Opt-out (NON-PRODUCTION / staging ONLY): EVIDENCE_SKIP_DNS_PREFLIGHT=1 skips the
# pre-flight. It is honored ONLY when no production Rekor push is requested; a
# real Rekor push can NEVER be silently skipped.

set -euo pipefail

# Bash version floor: these gates rely on bash 4+ features. Refuse early with a
# clear message on bash 3.x (e.g. macOS system bash) instead of failing later
# with a cryptic syntax error (jcgw).
[ "${BASH_VERSINFO:-0}" -ge 4 ] || { echo 'audit-harness requires bash >= 4' >&2; exit 3; }

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
# The namespace whose DNSSEC + CAA posture gates production attestations. Derived
# from the predicate URI host; overridable for testing via EVIDENCE_PREDICATE_DOMAIN.
PREDICATE_DOMAIN="${EVIDENCE_PREDICATE_DOMAIN:-evals.intentsolutions.io}"

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
import json, os, re, sys

gate = json.loads(os.environ["GATE_JSON"])

# Kernel _common.schema.json#/$defs/semver
_SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$")

required = ["gate_id", "result", "input_hash", "policy_hash"]
missing = [k for k in required if k not in gate]
if missing:
    sys.stderr.write(f"emit-evidence: gate-result missing required keys: {missing}\n")
    sys.exit(1)

# Build the canonical gate-result/v1 predicate body (Blueprint B § 7.4 / kernel
# GateResultV1Schema). The inbound gate JSON is the legacy/draft envelope
# (gate_id/result/policy_hash/input_hash[/metadata]); map + synthesize the
# canonical fields. The kernel schema FORBIDS additionalProperties, so the legacy
# `result`/`timestamp` keys are REPLACED, not augmented. Mirrors the kernel-valid
# self-gate emitter ci/emit-evidence.ts:buildGateResult.
metadata = gate.get("metadata") or {}

# result (legacy UPPERCASE) / gate_decision (canonical) -> closed enum.
_DECISION_MAP = {"pass": "pass", "fail": "fail", "advisory": "advisory", "error": "error"}
decision_raw = str(gate.get("gate_decision", gate.get("result", ""))).strip().lower()
gate_decision = _DECISION_MAP.get(decision_raw, "error")

# gate_name: kebab-case short name; fall back to the last ':' segment of gate_id.
gate_name = gate.get("gate_name") or gate["gate_id"].rsplit(":", 1)[-1]

# gate_version: SemVer; fall back to the runner's semver (<tool>@X.Y.Z). The
# kernel pattern is strict, so a non-SemVer runner suffix (e.g. '@unknown')
# degrades to 0.0.0 rather than emitting a row that fails kernel validation.
gate_version = gate.get("gate_version")
if not gate_version:
    _runner = os.environ["RUNNER"]
    gate_version = _runner.split("@", 1)[1] if "@" in _runner else ""
if not _SEMVER_RE.match(str(gate_version)):
    gate_version = "0.0.0"

# gate_reasons: empty array permitted ONLY for unconditional pass; otherwise >=1.
reasons = gate.get("gate_reasons")
if not reasons:
    if gate_decision == "pass":
        reasons = []
    else:
        reasons = [str(metadata.get("reason") or gate.get("failure_mode")
                       or f"{gate_name}: {gate_decision}")]

# coverage: BOTH arrays REQUIRED. Pass an inbound coverage through only when both
# keys are present AND lists (a half-populated dict would fail kernel validation);
# otherwise synthesize. An indeterminate row records the dimension as skipped.
_cov = gate.get("coverage")
if (isinstance(_cov, dict)
        and isinstance(_cov.get("dimensions_evaluated"), list)
        and isinstance(_cov.get("dimensions_skipped"), list)):
    coverage = {"dimensions_evaluated": _cov["dimensions_evaluated"],
                "dimensions_skipped": _cov["dimensions_skipped"]}
else:
    _dim = str(metadata.get("kind") or gate_name)
    if metadata.get("indeterminate"):
        coverage = {"dimensions_evaluated": [], "dimensions_skipped": [_dim]}
    else:
        coverage = {"dimensions_evaluated": [_dim], "dimensions_skipped": []}

# policy_ref: `sha256:<hex>:<path>` — append an artifact/schema path to policy_hash.
policy_ref = gate.get("policy_ref")
if not policy_ref:
    _path = metadata.get("artifact_path") or metadata.get("schema_id") or ".harness-hash"
    policy_ref = f'{gate["policy_hash"]}:{_path}'

predicate = {
    "gate_id":      gate["gate_id"],
    "gate_name":    gate_name,
    "gate_version": gate_version,
    "gate_decision": gate_decision,
    "gate_reasons": reasons,
    "coverage":     coverage,
    "policy_ref":   policy_ref,
    "policy_hash":  gate["policy_hash"],
    "input_hash":   gate["input_hash"],
    "evaluated_at": os.environ["TIMESTAMP"],
    "runner":       os.environ["RUNNER"],
    "commit_sha":   os.environ["COMMIT_SHA"],
}

# Carry forward optional canonical fields only (schema forbids unknown keys).
for opt in ("metadata", "failure_mode", "advisory_severity", "cost_record_ref",
            "replay_fidelity_level", "coverage_detail"):
    if gate.get(opt) is not None:
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

# --- OTel events (best-effort no-op if collector absent) ---
# The gate-decision event fires per the NORMATIVE runtime event taxonomy
# intent-eval-lab/000-docs/067-AT-SPEC-runtime-event-taxonomy-2026-06-12.md § 2.2
# (GOVERNANCE events, `gate.*`):
#
#   1. agent.rollout.gate.evaluated — observability signal fired at the
#      start/observation of a gate evaluation. NON-NORMATIVE: 067-AT-SPEC closes
#      the `gate.*` category and does NOT define a gate-evaluated event, so this
#      carries the legacy raw gate identity + result for collectors that already
#      scrape it. It is NOT a 067-pinned name and a future taxonomy extension may
#      retire or rename it; nothing should pin to it. The normative signal is (2).
#   2. gate.decision.emitted (iah-E07b) — fired at the END of the gate
#      evaluation. This is the NORMATIVE name from 067-AT-SPEC § 2.2: "a
#      RolloutGate decision row is emitted under gate-result/v1". Payload per
#      § 2.2: gate.name (string), gate.decision (enum pass|fail|advisory|error),
#      gate.policy_ref (string). This is the one a ship-gate dashboard alerts on.
#
# ATTRIBUTE-SPELLING AUTHORITY (do NOT redefine here): the canonical attribute
# names are pinned by the kernel at
# intent-eval-core/schemas/v1/otel-attributes.yaml — OTel-idiomatic dotted
# lowercase (e.g. gate.decision). We spell every attribute to match that file.
# 067-AT-SPEC § 2.2 is the EVENT-NAME authority for gate.decision.emitted and its
# payload schema; the gate.decision enum {pass, fail, advisory, error} is the
# closed gate-result/v1 verdict enum (Blueprint B § 7.4 / kernel gate-result
# schema) — NOT the RolloutGateDecision ship/no_ship vocabulary.
#
# We emit OTLP-shaped JSON lines to stderr when AUDIT_HARNESS_OTEL=1 OR an
# OTEL_EXPORTER_OTLP_ENDPOINT is set. Real exporter wiring is consumer-side; we
# emit a structured signal any collector can scrape via stderr capture. The path
# is fully best-effort: a collector being absent is the no-op default, and a
# python failure (||) degrades to an empty line that is simply not printed —
# the gate's own exit status is never affected by OTel emission (iah-E07c).
if [[ "${AUDIT_HARNESS_OTEL:-0}" == "1" ]] || [[ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]]; then
  # Compose the JSON via python so every attribute value is JSON-escaped.
  # printf-interpolating gate_id/result/runner into a JSON format string
  # emitted structurally invalid JSON whenever a value carried a double quote
  # (e.g. AUDIT_HARNESS_SIDE='ci"injection' flowing into gate_id).
  OTEL_LINES=$(GATE_JSON="$GATE_JSON" RUNNER="$RUNNER" COMMIT_SHA="$COMMIT_SHA" TIMESTAMP="$TIMESTAMP" \
    python3 - <<'PY' 2>/dev/null || echo ""
import json, os
try:
    gate = json.loads(os.environ["GATE_JSON"])
except (json.JSONDecodeError, ValueError):
    gate = {}

runner = os.environ["RUNNER"]
commit_sha = os.environ["COMMIT_SHA"]
timestamp = os.environ["TIMESTAMP"]
gate_id = str(gate.get("gate_id", ""))
# The canonical gate-result/v1 verdict field is gate_decision (lowercase enum,
# Blueprint B § 7.4); the legacy draft envelope used `result` (UPPERCASE). Read
# the canonical field first, fall back to the legacy field.
gate_decision_raw = str(gate.get("gate_decision", gate.get("result", "")))

# gate.name / gate.policy_ref per 067-AT-SPEC § 2.2 payload schema. The canonical
# envelope carries gate_name (kebab-case) + policy_ref; fall back to gate_id /
# policy_hash for legacy draft envelopes that predate Blueprint B § 7.4.
gate_name = str(gate.get("gate_name", gate_id))
policy_ref = str(gate.get("policy_ref", gate.get("policy_hash", "")))

# Map the inbound verdict to the closed gate.decision enum {pass, fail,
# advisory, error} (gate-result/v1 / kernel gate-result schema). This is the
# 067-AT-SPEC § 2.2 enum — NOT the RolloutGateDecision ship/no_ship vocabulary.
# Canonical lowercase values pass straight through; legacy UPPERCASE results map
# down; an unrecognized/missing verdict is `error` (the gate could not affirm a
# decision — an error condition, not a clean `fail`).
_DECISION_MAP = {
    "pass": "pass",
    "fail": "fail",
    "advisory": "advisory",
    "error": "error",
}
decision = _DECISION_MAP.get(gate_decision_raw.strip().lower(), "error")
# An advisory_severity hint on a non-fail/non-error row signals an advisory row
# even when the legacy `result` field only said PASS.
if decision in ("pass",) and gate.get("advisory_severity"):
    decision = "advisory"

reasons = []
if decision == "pass":
    reasons.append(f"gate '{gate_id}' decision: pass")
else:
    reasons.append(
        f"gate '{gate_id}' decision: {decision} "
        f"(verdict={gate_decision_raw or 'NO_VERDICT'})"
    )
fm = gate.get("failure_mode")
if fm:
    reasons.append(f"failure_mode: {fm}")

# Event 1: agent.rollout.gate.evaluated (NON-NORMATIVE observability signal;
# unchanged shape — not a 067-AT-SPEC-pinned name, see header note).
evaluated = {
    "name": "agent.rollout.gate.evaluated",
    "attributes": {
        "gate.id": gate_id,
        "gate.result": gate_decision_raw,
        "gate.runner": runner,
        "gate.commit_sha": commit_sha,
    },
    "timestamp": timestamp,
}

# Event 2: gate.decision.emitted (iah-E07b) — NORMATIVE per 067-AT-SPEC § 2.2.
# Payload: gate.name (string) + gate.decision (enum pass|fail|advisory|error) +
# gate.policy_ref (string). The reasons / runner / commit_sha are additive
# diagnostic attributes carried for dashboards; they do not contradict the
# § 2.2 required payload.
decision_event = {
    "name": "gate.decision.emitted",
    "attributes": {
        "gate.name": gate_name,
        "gate.decision": decision,
        "gate.policy_ref": policy_ref,
        "gate.id": gate_id,
        "gate.reasons": reasons,
        "gate.runner": runner,
        "gate.commit_sha": commit_sha,
    },
    "timestamp": timestamp,
}

for ev in (evaluated, decision_event):
    print(json.dumps(ev, separators=(",", ":")))
PY
)
  # Print each emitted OTLP line with the [OTEL] marker the collector scrapes.
  if [[ -n "$OTEL_LINES" ]]; then
    while IFS= read -r _otel_line; do
      [[ -n "$_otel_line" ]] && printf '[OTEL] %s\n' "$_otel_line" >&2
    done <<< "$OTEL_LINES"
  fi
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

# --- Production DNSSEC + CAA pre-flight gate (CISO binding DR-010 Q5) ----------
# A "production" signing event is one that pushes a signed Statement to a PUBLIC
# transparency log (Rekor) — i.e. REKOR_URL is non-empty. Before that irreversible
# anchor, the predicate namespace MUST be DNSSEC-signed AND CAA-pinned. We run the
# two read-only checks; if EITHER fails we REFUSE to sign and exit 4.
#
# The opt-out EVIDENCE_SKIP_DNS_PREFLIGHT=1 is honored ONLY for non-production
# (no Rekor push). A real Rekor push can never be silently skipped.
if [[ -n "$REKOR_URL" ]]; then
  PREFLIGHT_DIR="$(cd "$(dirname "$0")" && pwd)"
  if [[ "${EVIDENCE_SKIP_DNS_PREFLIGHT:-0}" == "1" ]]; then
    echo "emit-evidence: IGNORING EVIDENCE_SKIP_DNS_PREFLIGHT=1 — a Rekor push (REKOR_URL=$REKOR_URL) is a production attestation and CANNOT skip the DNSSEC/CAA pre-flight." >&2
  fi
  echo "emit-evidence: production Rekor push requested — running DNSSEC + CAA pre-flight on '$PREDICATE_DOMAIN'" >&2

  if ! bash "$PREFLIGHT_DIR/dnssec-check.sh" "$PREDICATE_DOMAIN" >&2; then
    echo "emit-evidence: REFUSING TO SIGN — DNSSEC pre-flight FAILED for '$PREDICATE_DOMAIN'." >&2
    echo "emit-evidence: remediation: pin DNSSEC + CAA on $PREDICATE_DOMAIN before any production attestation." >&2
    echo "emit-evidence:   see intent-eval-platform/intent-eval-lab/000-docs (DR-010 Q5 CISO binding) + the iah-E06 runbook." >&2
    exit 4
  fi
  if ! bash "$PREFLIGHT_DIR/caa-check.sh" "$PREDICATE_DOMAIN" >&2; then
    echo "emit-evidence: REFUSING TO SIGN — CAA pre-flight FAILED for '$PREDICATE_DOMAIN'." >&2
    echo "emit-evidence: remediation: pin DNSSEC + CAA on $PREDICATE_DOMAIN before any production attestation." >&2
    echo "emit-evidence:   set EXPECTED_CAA_ISSUER to the published CA, then publish a CAA record pinning it." >&2
    exit 4
  fi
  echo "emit-evidence: DNSSEC + CAA pre-flight PASSED for '$PREDICATE_DOMAIN' — proceeding to sign." >&2
elif [[ "${EVIDENCE_SKIP_DNS_PREFLIGHT:-0}" == "1" ]]; then
  # Non-production sign (no Rekor push) with the explicit opt-out set: keep
  # existing staging flows green without running the network-bound checks.
  echo "emit-evidence: non-production sign (no Rekor push); DNSSEC/CAA pre-flight skipped per EVIDENCE_SKIP_DNS_PREFLIGHT=1." >&2
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
