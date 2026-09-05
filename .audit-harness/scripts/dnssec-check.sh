#!/usr/bin/env bash
# dnssec-check.sh — verify a namespace is DNSSEC-signed before a production
# signed attestation is anchored against it.
#
# WHY THIS EXISTS (CISO binding, DR-010 Q5 / ISEDC v1 Q1 2026-05-10):
#   Predicate URIs for the Evidence Bundle live ONLY at evals.intentsolutions.io.
#   Pushing a signed in-toto Statement to a PUBLIC transparency log (Rekor)
#   against an unsigned namespace is irreversible and lets an attacker who can
#   spoof the zone mint look-alike attestations. DNSSEC must be verified on the
#   namespace BEFORE the first production attestation. This script is that gate.
#   It anchors NOTHING — it is a read-only verification that can only make
#   signing MORE conservative (fail-closed).
#
# WHY IT QUERIES AN EXPLICIT RESOLVER (the bug this version fixes):
#   Querying the LOCAL STUB RESOLVER (plain `dig`, no `@server`) FALSE-NEGATIVES
#   on hosts whose stub resolver strips DNSSEC records or never sets the AD bit
#   (systemd-resolved, most CI runners, dev boxes behind a caching forwarder).
#   On such a host a correctly DNSSEC-signed zone looks unsigned. For a
#   fail-closed gate that is the WRONG failure mode for usability AND it can
#   block a legitimate production signing while a genuinely-unsigned zone would
#   also block — i.e. it loses all discriminating power. The fix is to query a
#   TRUSTED VALIDATING resolver and require the resolver to assert validation
#   (`delv` full-chain "fully validated", or `dig`'s AD bit + an RRSIG). The
#   gate stays fail-closed: PASS only on positive confirmation from a trusted
#   resolver; UNKNOWN / unreachable / no-tool => non-zero.
#
# Usage:
#   bash scripts/dnssec-check.sh [DOMAIN]
#   DNSSEC_CHECK_DOMAIN=evals.intentsolutions.io bash scripts/dnssec-check.sh
#
# Resolution order for the domain:
#   1. $1 (positional)
#   2. $DNSSEC_CHECK_DOMAIN
#   3. default: evals.intentsolutions.io
#
# Behavior:
#   - Queries each resolver in $DNSSEC_CHECK_RESOLVERS (default 1.1.1.1 8.8.8.8),
#     in order, and PASSES on the FIRST that confirms DNSSEC validation.
#   - For each resolver: prefers `delv @<resolver>` (full DNSSEC chain validation
#     against the IANA trust anchor; "fully validated" => PASS). Falls back to
#     `dig @<resolver> +dnssec` and requires BOTH the AD (Authenticated Data)
#     header flag AND the presence of an RRSIG record (a non-validating answer,
#     i.e. RRSIG but no AD, does NOT pass — a malicious/forwarding resolver that
#     returns records without validating the chain cannot trivially pass).
#   - If NO resolver confirms validation (every resolver says unsigned, or is
#     unreachable), exits 1 (fail-closed).
#   - If NEITHER delv NOR dig is installed, emits a typed UNKNOWN/UNREACHABLE
#     result and exits 2 (fail-closed for production).
#
# Exit codes:
#   0 — DNSSEC verified (a trusted resolver fully validated, or set AD + RRSIG)
#   1 — DNSSEC NOT verified (no trusted resolver confirmed; zone unsigned /
#       validation failed / all resolvers unreachable)
#   2 — UNKNOWN/UNREACHABLE (no resolver tool installed at all)
#
# Override knobs:
#   DNSSEC_CHECK_RESOLVERS — space-separated list of validating/public resolvers
#                            to query in order (default: "1.1.1.1 8.8.8.8").
#   DNSSEC_CHECK_DELV_CMD   — command used in place of `delv` (default: delv)
#   DNSSEC_CHECK_DIG_CMD    — command used in place of `dig`  (default: dig)

set -euo pipefail

DOMAIN="${1:-${DNSSEC_CHECK_DOMAIN:-evals.intentsolutions.io}}"
DELV_CMD="${DNSSEC_CHECK_DELV_CMD:-delv}"
DIG_CMD="${DNSSEC_CHECK_DIG_CMD:-dig}"
# Trusted validating/public resolvers, queried in order. Cloudflare (1.1.1.1)
# and Google (8.8.8.8) both perform DNSSEC validation and set the AD bit.
RESOLVERS="${DNSSEC_CHECK_RESOLVERS:-1.1.1.1 8.8.8.8}"

log() { printf 'dnssec-check: %s\n' "$1" >&2; }

if [[ "$DOMAIN" == "-h" || "$DOMAIN" == "--help" ]]; then
  sed -n '2,60p' "$0"
  exit 0
fi

have() { command -v "$1" >/dev/null 2>&1; }

have_delv=0
have_dig=0
have "$DELV_CMD" && have_delv=1
have "$DIG_CMD" && have_dig=1

# --- No resolver tool at all -> typed UNKNOWN, fail-closed (exit 2) ---
if [[ "$have_delv" -eq 0 && "$have_dig" -eq 0 ]]; then
  log "UNKNOWN/UNREACHABLE — neither '$DELV_CMD' nor '$DIG_CMD' is installed"
  log "  cannot verify DNSSEC for '$DOMAIN'; failing closed (production must not sign on UNKNOWN)"
  log "  remediation: install bind9-dnsutils (provides dig + delv) on the signing host"
  exit 2
fi

# delv_validates RESOLVER -> 0 if delv reports the chain fully validated.
delv_validates() {
  local resolver="$1" out
  # delv prints "; fully validated" on each validated RRset when the chain of
  # trust holds; "; unsigned answer" / "resolution failed" otherwise. delv
  # validates LOCALLY against the IANA trust anchor regardless of which resolver
  # serves the records, so a non-validating @resolver cannot fake a pass.
  out="$("$DELV_CMD" "$DOMAIN" "@$resolver" 2>&1 || true)"
  printf '%s\n' "$out" | grep -q "fully validated"
}

# dig_validates RESOLVER -> 0 if the resolver set the AD bit AND an RRSIG is
# present. BOTH are required: AD alone could be spoofed by a lying resolver
# without signatures, RRSIG alone proves the zone publishes signatures but not
# that the chain validated. Requiring AD means a non-validating resolver's
# answer (RRSIG copied through, AD never set) does NOT pass.
dig_validates() {
  local resolver="$1" out ad_flag=0 rrsig=0
  out="$("$DIG_CMD" "@$resolver" +dnssec +multiline "$DOMAIN" 2>&1 || true)"
  if printf '%s\n' "$out" | grep -qE '^;; flags:[^;]*\bad\b'; then
    ad_flag=1
  fi
  if printf '%s\n' "$out" | grep -qE '[[:space:]]RRSIG[[:space:]]'; then
    rrsig=1
  fi
  [[ "$ad_flag" -eq 1 && "$rrsig" -eq 1 ]]
}

saw_unsigned=0  # at least one resolver answered, and said NOT validated

for resolver in $RESOLVERS; do
  # --- Path 1: delv @resolver (authoritative DNSSEC chain validation) ---
  if [[ "$have_delv" -eq 1 ]]; then
    log "validating DNSSEC for '$DOMAIN' via $DELV_CMD @$resolver"
    if delv_validates "$resolver"; then
      log "VERIFIED — '$DOMAIN' is DNSSEC-signed (delv @$resolver: fully validated)"
      exit 0
    fi
    saw_unsigned=1
    log "delv @$resolver did not confirm validation; trying dig @$resolver"
  fi

  # --- Path 2: dig @resolver +dnssec (AD bit + RRSIG presence) ---
  if [[ "$have_dig" -eq 1 ]]; then
    log "checking DNSSEC for '$DOMAIN' via $DIG_CMD @$resolver +dnssec"
    if dig_validates "$resolver"; then
      log "VERIFIED — '$DOMAIN' is DNSSEC-signed (dig @$resolver: AD bit set + RRSIG present)"
      exit 0
    fi
    saw_unsigned=1
    log "dig @$resolver did not confirm validation (no AD+RRSIG) for '$DOMAIN'"
  fi
done

# No resolver confirmed validation. Distinguish "answered but unsigned" from
# "nothing reachable" only for the operator message — both fail-closed (exit 1).
if [[ "$saw_unsigned" -eq 1 ]]; then
  log "NOT VERIFIED — no trusted resolver confirmed DNSSEC for '$DOMAIN' (zone appears unsigned / chain not validated)"
  log "  resolvers tried: $RESOLVERS"
  log "  remediation: sign the zone (DNSSEC) at the registrar/DNS host, then re-run"
else
  log "NOT VERIFIED — could not reach any resolver to validate DNSSEC for '$DOMAIN'"
  log "  resolvers tried: $RESOLVERS"
  log "  failing closed (production must not sign without positive confirmation)"
fi
exit 1
