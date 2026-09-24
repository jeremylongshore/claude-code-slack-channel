#!/usr/bin/env bash
# caa-check.sh — verify a namespace publishes CAA records (and, when configured,
# pins the EXPECTED certificate authority) before a production signed attestation
# is anchored against it.
#
# WHY THIS EXISTS (CISO binding, DR-010 Q5 / ISEDC v1 Q1 2026-05-10):
#   CAA (RFC 8659) records constrain which CAs may issue certificates for a
#   namespace. Pinning the CA on evals.intentsolutions.io closes the mis-issuance
#   path an attacker could otherwise use to obtain a look-alike cert and present
#   forged attestation infrastructure. This must be verified BEFORE the first
#   production attestation. This script is that gate — read-only, fail-closed.
#
# WHY IT QUERIES AN EXPLICIT RESOLVER (the bug this version fixes):
#   Querying the LOCAL STUB RESOLVER (plain `dig`, no `@server`) FALSE-NEGATIVES
#   on hosts whose stub resolver lags CAA propagation or strips the record type
#   (systemd-resolved, many CI runners, dev boxes). On such a host a correctly
#   CAA-pinned zone looks like it has no CAA, and the gate refuses a legitimate
#   production sign. The fix is to query a TRUSTED PUBLIC resolver. The gate
#   stays fail-closed: PASS only on a positive matching CAA record from a trusted
#   resolver; absence / mismatch / unreachable => non-zero.
#
# Usage:
#   bash scripts/caa-check.sh [DOMAIN]
#   EXPECTED_CAA_ISSUER=letsencrypt.org bash scripts/caa-check.sh evals.intentsolutions.io
#
# Resolution order for the domain:
#   1. $1 (positional)
#   2. $CAA_CHECK_DOMAIN
#   3. default: evals.intentsolutions.io
#
# Issuer policy:
#   - EXPECTED_CAA_ISSUER (env) — when set, at least one CAA `issue` (or
#     `issuewild`) record MUST name this CA, else the check FAILS (exit 1).
#     Default: letsencrypt.org (the CA the IS public-namespace certs are issued
#     by). Override per-deployment.
#   - EXPECTED_CAA_ISSUER=ANY (case-insensitive) — relax to "any CAA record is
#     acceptable"; presence of ANY CAA record passes, absence fails, and a
#     warning is emitted that no specific CA is being pinned.
#
# Exit codes:
#   0 — CAA verified (present at a trusted resolver, and matches
#       EXPECTED_CAA_ISSUER when a specific issuer is required)
#   1 — CAA NOT verified (no CAA records, or expected issuer not present, from
#       any trusted resolver)
#   2 — UNKNOWN/UNREACHABLE (no resolver tool installed)
#
# Override knobs:
#   CAA_CHECK_RESOLVERS — space-separated list of trusted public resolvers to
#                         query in order (default: "1.1.1.1 8.8.8.8").
#   CAA_CHECK_DIG_CMD   — command used in place of `dig` (default: dig)

set -euo pipefail

DOMAIN="${1:-${CAA_CHECK_DOMAIN:-evals.intentsolutions.io}}"
EXPECTED_CAA_ISSUER="${EXPECTED_CAA_ISSUER:-letsencrypt.org}"
DIG_CMD="${CAA_CHECK_DIG_CMD:-dig}"
# Trusted public resolvers, queried in order, until one returns a CAA record.
RESOLVERS="${CAA_CHECK_RESOLVERS:-1.1.1.1 8.8.8.8}"

log() { printf 'caa-check: %s\n' "$1" >&2; }

if [[ "$DOMAIN" == "-h" || "$DOMAIN" == "--help" ]]; then
  sed -n '2,60p' "$0"
  exit 0
fi

have() { command -v "$1" >/dev/null 2>&1; }

if ! have "$DIG_CMD"; then
  log "UNKNOWN/UNREACHABLE — '$DIG_CMD' is not installed; cannot look up CAA for '$DOMAIN'"
  log "  failing closed (production must not sign on UNKNOWN)"
  log "  remediation: install bind9-dnsutils (provides dig) on the signing host"
  exit 2
fi

# issuer_matches CAA_TEXT -> 0 if a matching issue/issuewild record is present.
# Match any `issue` or `issuewild` property whose value contains the expected
# CA. CAA values are quoted; we match case-insensitively on the issuer substring.
issuer_matches() {
  printf '%s\n' "$1" \
    | grep -iE '[[:space:]]issue(wild)?[[:space:]]' \
    | grep -iqF "$EXPECTED_CAA_ISSUER"
}

# is_blank CAA_TEXT -> 0 if the text is empty after stripping whitespace.
is_blank() {
  [[ -z "${1//[$' \t\r\n']/}" ]]
}

last_caa_out=""   # records from the last resolver that returned ANY CAA records
saw_records=0     # at least one trusted resolver returned CAA records

shopt -s nocasematch
relax_any=0
[[ "$EXPECTED_CAA_ISSUER" == "ANY" ]] && relax_any=1
shopt -u nocasematch

for resolver in $RESOLVERS; do
  log "looking up CAA records for '$DOMAIN' via $DIG_CMD @$resolver"
  # `dig @resolver +short CAA` prints one line per record, e.g.:
  #   0 issue "letsencrypt.org"
  #   0 issuewild ";"
  caa_out="$("$DIG_CMD" "@$resolver" +short CAA "$DOMAIN" 2>/dev/null || true)"

  if is_blank "$caa_out"; then
    log "  no CAA records returned by @$resolver"
    continue
  fi

  saw_records=1
  last_caa_out="$caa_out"

  # --- ANY-issuer relaxation: any CAA record present passes ---
  if [[ "$relax_any" -eq 1 ]]; then
    log "VERIFIED (presence only) — CAA records exist for '$DOMAIN' (via @$resolver)"
    log "  WARNING: EXPECTED_CAA_ISSUER=ANY — no specific CA is being pinned."
    log "  Records found:"
    printf '%s\n' "$caa_out" | sed 's/^/    /' >&2
    exit 0
  fi

  # --- Specific-issuer pinning ---
  if issuer_matches "$caa_out"; then
    log "VERIFIED — '$DOMAIN' pins issuance to '$EXPECTED_CAA_ISSUER' (via @$resolver)"
    exit 0
  fi

  log "  CAA records exist at @$resolver but none pin '$EXPECTED_CAA_ISSUER'; trying next resolver"
done

# No trusted resolver yielded a matching CAA record -> fail-closed (exit 1).
if [[ "$saw_records" -eq 1 ]]; then
  log "NOT VERIFIED — CAA records exist for '$DOMAIN' but none pin '$EXPECTED_CAA_ISSUER'"
  log "  Records found:"
  printf '%s\n' "$last_caa_out" | sed 's/^/    /' >&2
  log "  remediation: add a CAA record pinning the expected CA, or set"
  log "  EXPECTED_CAA_ISSUER to the CA actually published (or ANY to accept any CAA)."
else
  log "NOT VERIFIED — no CAA records found for '$DOMAIN' (resolvers tried: $RESOLVERS)"
  log "  remediation: publish a CAA record pinning the issuing CA, e.g.:"
  log "    $DOMAIN. CAA 0 issue \"$EXPECTED_CAA_ISSUER\""
fi
exit 1
