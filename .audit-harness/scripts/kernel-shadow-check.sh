#!/usr/bin/env bash
# kernel-shadow-check.sh — flag local re-declarations of kernel-owned contracts.
#
# The kernel @intentsolutions/core is the single source of truth for the
# canonical platform contracts: the gate-result/v1 predicate shape and the
# evidence-bundle payload shape (and, downstream, the authoring/v1 artifact
# schemas). This repo (audit-harness) is a CONSUMER of those contracts — it
# emits gate-result rows and EvidenceBundles, it must NOT re-define their
# shapes. A local re-declaration ("shadow") is supply-chain drift: the harness
# would validate against its own stale copy instead of the kernel the dashboard
# verifies with.
#
# This detector greps for files that re-DECLARE a kernel-owned schema shape,
# as opposed to REFERENCING the kernel (importing from @intentsolutions/core,
# or naming the predicate URI in a gate_id string — both legitimate).
#
# A SHADOW is:
#   * a JSON Schema document whose "$id" claims a kernel-owned canonical id
#     (evals.intentsolutions.io/gate-result/... or .../evidence-bundle/...), OR
#   * a TS/Python source file that DEFINES (not imports) a GateResultV1 /
#     EvidenceBundle / EvidenceBundlePayload type/interface/class.
#
# NOT a shadow (allowlisted):
#   * tests/fixtures/**   — a frozen offline copy of the kernel schema, pinned
#                           deliberately so the regression suite runs without a
#                           network fetch. This is a test pin, not a contract.
#   * ci/**               — the CI-only emitter; it IMPORTS the kernel validators
#                           (@intentsolutions/core/validators/v1/*) and only
#                           declares emitter-internal plumbing types.
#   * schemas/conform/**  — the harness's OWN deterministic structural floor for
#                           authoring artifacts, namespaced under conform/v1.
#                           This is a separate, shallower contract from the
#                           kernel authoring/v1 validity SSoT — intentionally
#                           different, not a re-declaration.
#   * **/dist/**, **/build/**
#                         — compiler output. Whatever a bundle or .d.ts contains
#                           is a mechanical restatement of source that this
#                           detector already checks; flagging both reports one
#                           authoring decision twice and cannot be fixed in the
#                           generated file.
#
# NOT a shadow (by construction — the anchors below):
#   * `export { type EvidenceBundle, ... } from "@intentsolutions/core/..."`
#     A re-export entry names the kernel's type in order to FORWARD it. That is
#     the single-source-of-truth pattern this detector exists to encourage, and
#     matching it was a false positive that flagged three j-rig files for doing
#     exactly the right thing. The identifier in a re-export or import list is
#     followed by `,`, `}`, or a newline — never by declaration syntax — so the
#     anchors require `=`, `{`, `<`, `(`, `:`, `extends`, or `implements` after
#     the name.
#
# Background: iah-E02 (the architecture question — peerDep-only vs full TS port
# vs second-emitter — that historically blocked a standing kernel-shadow check)
# is now CLOSED, so this detector ships.
#
# Exit codes:
#   0 — no shadows found (or shadows found in advisory/default mode)
#   1 — shadows found AND --strict was passed (gate)
#
# Default mode is ADVISORY (exit 0, annotate). Pass --strict to make a shadow
# a hard failure. CI runs the advisory mode so the lane is green while still
# surfacing any shadow as a GitHub annotation.

set -euo pipefail

# Bash version floor: these gates rely on bash 4+ features. Refuse early with a
# clear message on bash 3.x (e.g. macOS system bash) instead of failing later
# with a cryptic syntax error (jcgw).
[ "${BASH_VERSINFO:-0}" -ge 4 ] || { echo 'audit-harness requires bash >= 4' >&2; exit 3; }

STRICT=0
ROOT="."
while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict) STRICT=1; shift ;;
    --root) ROOT="${2:-.}"; shift 2 ;;
    --help|-h)
      echo "Usage: kernel-shadow-check.sh [--strict] [--root DIR]"
      echo "  Flags local re-declarations of kernel-owned gate-result/evidence-bundle contracts."
      echo "  Default: advisory (exit 0). --strict: exit 1 on any shadow."
      exit 0 ;;
    *) echo "kernel-shadow-check: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

cd "$ROOT"

# Paths that are allowed to carry a kernel-shaped artifact (see header).
# A match is a shadow only if it is OUTSIDE all of these.
is_allowlisted() {
  case "$1" in
    tests/fixtures/*) return 0 ;;
    ci/*)             return 0 ;;
    schemas/conform/*) return 0 ;;
    node_modules/*)   return 0 ;;
    .git/*)           return 0 ;;
    dist/*|*/dist/*)   return 0 ;;
    build/*|*/build/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The class-2 declaration anchor (see the block comment above the class-2 loop).
CLASS2_PATTERN='(^|[[:space:]])((export|declare|abstract)[[:space:]]+)*(interface|class|type)[[:space:]]+(EvidenceBundlePayload|EvidenceBundle|GateResultV1)([[:space:]]*[{<(:=]|[[:space:]]+(extends|implements)[[:space:]])'

# is_kernel_imported FILE SYMBOL — true when SYMBOL appears inside an import or
# re-export statement that resolves to @intentsolutions/core in FILE. Statements
# are reconstructed by joining the file and splitting on ';', so a multi-line
# `import {\n  A,\n  B,\n} from "@intentsolutions/core/..."` is handled.
is_kernel_imported() {
  local file="$1" sym="$2"
  awk -v sym="$sym" '
    { buf = buf " " $0 }
    END {
      n = split(buf, stmts, /;/)
      for (i = 1; i <= n; i++) {
        if (stmts[i] ~ /@intentsolutions\/core/ &&
            stmts[i] ~ ("(^|[^A-Za-z0-9_])" sym "([^A-Za-z0-9_]|$)")) { found = 1 }
      }
      exit(found ? 0 : 1)
    }
  ' "$file"
}

# is_kernel_derivation FILE LINE — true when LINE is a type alias whose right-hand
# side is a pure derivation of a kernel-imported symbol. Anything else (an
# interface, a class, a structural type literal, a union, or a derivation from a
# locally-declared schema) returns false and is treated as a real declaration.
is_kernel_derivation() {
  local file="$1" line="$2" rhs sym
  # Only `type X = ...` can derive; interface/class always declare a shape.
  [[ "$line" =~ (^|[[:space:]])((export|declare|abstract)[[:space:]]+)*type[[:space:]] ]] || return 1
  [[ "$line" == *=* ]] || return 1

  rhs="${line#*=}"
  # Strip comments, trailing semicolon, and surrounding whitespace.
  rhs="${rhs%%//*}"
  rhs="$(printf '%s' "$rhs" | sed -E 's/[[:space:]]*;?[[:space:]]*$//; s/^[[:space:]]+//')"

  if [[ "$rhs" =~ ^z\.(infer|input|output)\<typeof[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)\>$ ]]; then
    sym="${BASH_REMATCH[2]}"
  elif [[ "$rhs" =~ ^typeof[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)$ ]]; then
    sym="${BASH_REMATCH[1]}"
  elif [[ "$rhs" =~ ^([A-Za-z_][A-Za-z0-9_]*)$ ]]; then
    sym="${BASH_REMATCH[1]}"
  else
    return 1   # structural / union / intersection → a real declaration
  fi

  is_kernel_imported "$file" "$sym"
}

shadows=()

# 1. JSON Schema documents claiming a kernel-owned canonical $id.
#    The kernel owns gate-result/<ver> and evidence-bundle/<ver> ids under
#    evals.intentsolutions.io. conform/v1 ids are the harness's own (allowlisted
#    structurally by the schemas/conform/ path skip below).
#
#    EXEMPT: a redirect stub. A document that carries an `x-redirect` marker is
#    the ratified discoverability pattern (Blueprint B § 7.0 "Lab specs/ MAY host
#    redirect stubs"; ISEDC Session 5 DR-018 § 6.4 Option α-minus) — it claims the
#    id in order to $ref the kernel's schema, which is referencing, not
#    re-declaring. The lab's own schema-drift.yml already allowlists exactly this
#    marker; flagging it here would contradict a gate the platform ratified.
# shellcheck disable=SC2016  # the grep pattern's $id is a literal, not a shell var
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  rel="${f#./}"
  is_allowlisted "$rel" && continue
  grep -qE '"x-redirect"[[:space:]]*:' "$f" && continue
  shadows+=("$rel  (re-declares a kernel-owned JSON Schema \$id)")
done < <(grep -rIlE '"\$id"[[:space:]]*:[[:space:]]*"https://evals\.intentsolutions\.io/(gate-result|evidence-bundle)/' \
            --include='*.json' --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null || true)

# 2. TS/Python source DEFINING (not importing, not re-exporting) a kernel-owned
#    type/class. The keyword alone is not enough to tell a definition from a
#    re-export — `export { type EvidenceBundle } from "@intentsolutions/core"`
#    carries `type EvidenceBundle` too. What separates them is what FOLLOWS the
#    identifier, so the anchor requires actual declaration syntax:
#
#      interface X {        interface X<T>        interface X extends Y
#      class X {            class X<T>            class X extends Y
#      class X(Base):       class X:              class X implements Y   (py/ts)
#      type X =             type X<T> =
#
#    A re-export or import entry is followed by `,`, `}`, `;`, or end-of-line and
#    therefore cannot match. `declare`/`abstract` prefixes are tolerated.
#
#    EXEMPT: a pure DERIVATION of a kernel-imported symbol, e.g.
#      export type EvidenceBundle = z.infer<typeof EvidenceBundlePayloadSchema>;
#    where `EvidenceBundlePayloadSchema` is imported/re-exported from
#    @intentsolutions/core in the same file. Such an alias has no independent
#    shape — it is defined BY the kernel schema and changes when the kernel
#    changes, so it cannot drift, which is the entire harm this detector guards
#    against. Only three RHS forms qualify (`z.infer|input|output<typeof S>`,
#    `typeof S`, bare `S`); anything structural (`{`, `|`, `&`) is a real
#    declaration and still flags, as does a derivation from a NON-kernel symbol.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  rel="${f#./}"
  is_allowlisted "$rel" && continue

  # Per-LINE triage: a file is reported only if it holds at least one match that
  # is not an exempt kernel derivation.
  real_hits=()
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    lineno="${hit%%:*}"
    text="${hit#*:}"
    if is_kernel_derivation "$f" "$text"; then continue; fi
    real_hits+=("$lineno")
  done < <(grep -nE "$CLASS2_PATTERN" "$f" 2>/dev/null || true)

  [[ ${#real_hits[@]} -eq 0 ]] && continue
  lines="$(IFS=,; echo "${real_hits[*]}")"
  shadows+=("$rel  (defines a kernel-owned type at line(s) ${lines} — should import from @intentsolutions/core)")
done < <(grep -rIlE "$CLASS2_PATTERN" \
            --include='*.ts' --include='*.py' --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null || true)

if [[ ${#shadows[@]} -eq 0 ]]; then
  echo "kernel-shadow-check: clean — no local re-declarations of kernel-owned contracts."
  exit 0
fi

echo "kernel-shadow-check: found ${#shadows[@]} potential kernel shadow(s):" >&2
for s in "${shadows[@]}"; do
  echo "  - $s" >&2
  # GitHub Actions annotation (surfaces in the PR even in advisory mode).
  file_only="${s%%  *}"
  echo "::warning file=${file_only}::kernel shadow — this file re-declares a kernel-owned contract; reference @intentsolutions/core instead"
done

if [[ "$STRICT" -eq 1 ]]; then
  echo "kernel-shadow-check: --strict — failing the build." >&2
  exit 1
fi

echo "kernel-shadow-check: advisory mode — not failing the build (pass --strict to gate)." >&2
exit 0
