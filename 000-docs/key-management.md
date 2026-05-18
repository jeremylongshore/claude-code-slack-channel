# Key Management

Operational doc for the Ed25519 signing key that backs the audit journal
once `ccsc-22l` (journal v2) ships. This doc lands first — before any
signing code — so the load-bearing operational decisions are decided in
public, in writing, before any code depends on them. Pair this doc with
[`audit-journal-architecture.md`](audit-journal-architecture.md) (journal
v2 schema + verification semantics) and [`THREAT-MODEL.md`](THREAT-MODEL.md)
(invariant #7, T11).

---

## Scope

**In scope**: the Ed25519 keypair that signs every journal v2 event, where
it lives on disk, how it is decrypted at process startup, how it rotates,
how the public half is published for third-party verification, and how
loss of the private half is recovered from.

**Out of scope**: hardware-backed signing (YubiKey / TPM / KMS). The
single-host design of this bridge (one operator, one state dir, one
process) means a software keypair on the operator's box is the right
floor. Hardware backing is a future epic once a second principal lands
(see `ccsc-66t` ADR).

---

## Key file

| Property | Value |
|---|---|
| **Path** | `~/.claude/channels/slack/audit.key.sops.yaml` |
| **Format** | SOPS-encrypted YAML wrapping a base64-encoded 32-byte Ed25519 seed |
| **On-disk mode** | `0o600`, owned by the session owner |
| **Plaintext form at rest** | **NEVER**. The file on disk is always encrypted. |
| **Plaintext form in memory** | Loaded into the process's memory at boot, never written back to disk |
| **Decryption tmpfs (when needed)** | `/dev/shm/ccsc-audit.key.<pid>` — `0o600`, mode-checked before read, unlinked immediately after `loadKeyPair()` consumes it |

The SOPS dependency is explicit and accepted. Storing a raw 32-byte seed
in a flat `0o600` file would be one filesystem-snapshot away from leak;
SOPS+age aligns the signing-key posture with the rest of Intent Solutions'
secrets-at-rest standard (per `~/000-projects/CLAUDE.md` § "SOPS + age
secrets standard").

### `.sops.yaml` rule

The repo-level `.sops.yaml` already lists the operator's age recipient
public key. The audit-key file inherits that rule by path-prefix match —
no additional entry required. Engineers adding a new operator's recipient
follow the standard `sops-init --recipient age1...` flow, which re-encrypts
all SOPS files in the repo against the new recipient set.

---

## Boot-time decryption

```
process start
  │
  ▼
loadKeyPair("~/.claude/channels/slack/audit.key.sops.yaml")
  │
  ├─ if file missing AND --no-audit-signing flag set
  │      → return null; journal writes unsigned v2 events with `signature: null`
  │        (verifier accepts unsigned v2 in `relaxed` mode, refuses in `strict`)
  │
  ├─ if file missing AND --no-audit-signing flag NOT set
  │      → exit(2) with stderr:
  │        "FATAL: audit-signing key missing at <path>.
  │         Run `ccsc audit-key init` to generate, or pass --no-audit-signing
  │         to start in unsigned-relaxed mode (NOT recommended for production)."
  │
  ▼
sops -d <path> | yaml.parse → { seed: base64 }
  │
  ▼
Buffer.from(seed, 'base64') → 32-byte private seed
  │
  ▼
nobles/curves Ed25519 expandKey(seed) → { privateKey, publicKey }
  │
  ▼
keypair held in module-scope const; file descriptor closed; tmpfs unlinked
```

The CLI flag `--no-audit-signing` exists as the emergency-escape valve
documented in risk R10 of the rollout. It is not the default. Operators
who set it accept that journal verification by a third party using only
the published public key cannot confirm authenticity of events written
during the unsigned window.

---

## Key generation

`ccsc audit-key init` (added in `ccsc-22l`):

1. Validate `~/.claude/channels/slack/audit.key.sops.yaml` does not exist.
   Refuse to overwrite; key generation is one-shot per state dir. Operator
   must explicitly `ccsc audit-key rotate` to replace.
2. Generate 32 random bytes via `crypto.randomBytes(32)`.
3. Derive Ed25519 public key.
4. Write to a tmp file inside the state dir: `audit.key.sops.yaml.tmp`,
   mode `0o600`, content:
   ```yaml
   seed: <base64-encoded 32 bytes>
   created_at: "2026-05-17T03:42:00.000Z"
   purpose: "claude-code-slack-channel audit-journal v2 signing"
   ```
5. `sops --encrypt --in-place audit.key.sops.yaml.tmp`.
6. Atomic rename to `audit.key.sops.yaml`.
7. Print the public key (base64) to stdout. Operator runs:
   ```
   pass insert -e intentsolutions/ccsc/audit-pubkey
   # paste public key
   ```
   and creates the external-pin gist (next section).

---

## External public-key publication

For third-party verifiability, the public half of the keypair is pinned
in an operator-controlled GitHub gist. The gist URL is recorded:

1. In `~/.claude/channels/slack/audit-pubkey.txt` (a plain text file, not
   in the state dir for security purposes — just for operator convenience).
2. In the operator's `pass` store at `intentsolutions/ccsc/audit-pubkey`.
3. In the README of this repo, under the "Verifying audit journals"
   section (added by `ccsc-22l`).

Gist content (Markdown):

```markdown
# CCSC audit-journal public key

**Host**: <operator hostname>
**Repository**: claude-code-slack-channel (intentsolutions/ccsc)
**Purpose**: Ed25519 public key for verifying audit journal v2 events.

## Current key

- **Public key (base64)**: <88-char-base64>
- **Created**: YYYY-MM-DD
- **Algorithm**: Ed25519 (NIST FIPS 186-5)
- **Encoding**: 32-byte raw key, base64-encoded

## Verification

```bash
echo "<journal-event-JSON>" | jq -c | \
  bun -e 'const { verifySignature } = require("@noble/curves/ed25519");
          /* see audit-journal-architecture.md for the full verify CLI */'
```

## History

Previous keys (for verifying older journal segments):

| Public key | Used | Retired | Reason |
|---|---|---|---|
| (none yet) | | | |
```

**Why a gist, not the repo**: the repo's main branch is mutable
(force-push, history rewrite, branch deletion). A gist is a stable,
versioned, per-operator artifact that survives repo lifecycle events.
Public gists also support inline diff history — every public-key rotation
is itself an auditable event.

---

## Rotation cadence

**90 days**, computed from `created_at` in the SOPS-encrypted YAML.

`ccsc audit-key rotate` (added in `ccsc-22l`):

1. Load current keypair (per "Boot-time decryption" above).
2. Generate new keypair (same procedure as init).
3. Open the current `audit.log`, append one final v2 event under the OLD
   key:
   ```json
   {
     "v": 2,
     "kind": "system.key_rotation",
     "ts": "2026-08-15T12:00:00.000Z",
     "actor": "session_owner",
     "body": {
       "old_public_key": "<base64>",
       "new_public_key": "<base64>",
       "rotation_reason": "scheduled-90day" | "compromise-suspected" | "operator-initiated"
     },
     "prev_hash": "<sha256>",
     "hash": "<sha256>",
     "signature": "<base64 ed25519 sig with OLD private key>"
   }
   ```
4. Atomically swap `audit.key.sops.yaml.tmp` → `audit.key.sops.yaml`. The
   old encrypted file is moved to `audit.key.sops.yaml.<timestamp>.archived`
   inside the state dir so historical journal segments remain verifiable.
5. Update the external gist with the new public key + add a row to the
   "History" table.
6. Update `pass intentsolutions/ccsc/audit-pubkey` with the new value.

**Reading rotated chains**: the verifier walks `audit.log` from the
beginning; when it encounters a `system.key_rotation` event, it switches
the current verification key to `body.new_public_key` for subsequent
events. The rotation event itself MUST verify under the OLD key (asserts
that the rotation was authorized by the holder of the old private key).

**Cron suggestion**: a desktop reminder, not an automated rotation. Key
rotation involves the external gist update which is operator-mediated.
Automating it would expose the rotation to whatever process owns the
cron entry — typically not the bridge process.

---

## Backup

The operator's `pass` store at `intentsolutions/ccsc/audit-pubkey` holds
only the PUBLIC key. The PRIVATE seed is held only in the SOPS-encrypted
file on disk, decryptable only by an age recipient whose private key is
in `~/.config/sops/age/keys.txt` (per the Intent Solutions secrets
standard).

For disaster recovery (host loss, disk failure), the operator's age
private key must be backed up out of band. This is **the same backup
posture as every other SOPS-encrypted secret in the Intent Solutions
ecosystem** — see `~/.config/sops/age/keys.txt` and the operator's
existing backup procedure for it. The audit key adds no new backup
surface; it inherits the existing one.

**Anti-pattern**: do NOT back up `audit.key.sops.yaml` to a system that
does not also hold the age private key — the encrypted file alone is
useless. Conversely, the encrypted file is safe to push to any storage
medium (git, cloud sync, USB stick) precisely because the age private
key is required to decrypt it.

---

## Lost-key recovery

If the operator loses the SOPS-encrypted file (disk crash, accidental
`rm`, etc.) and has no backup:

1. **The old journal chain remains verifiable** as long as the gist
   still publishes the old public key. Any third party can verify
   events written under that key; what they cannot do is verify events
   written after the loss.
2. **Generate a new chain**:
   - `ccsc audit-key init` produces a new keypair.
   - The next journal write opens a NEW `audit.log.<timestamp>.continued`
     file with a synthetic genesis event whose `prev_hash` is the empty
     string. The old `audit.log` is renamed to
     `audit.log.<timestamp>.broken-chain` for forensic preservation.
   - The operator's gist gets a new entry in the History table
     documenting the loss + the new key.
3. **Forensic continuity**: the gap is itself recorded in the new chain
   (first event `kind: "system.chain_break"`, `body: { reason: "private_key_lost" }`).
   Investigators looking at the system can see the discontinuity and the
   reason; what they cannot do is verify any event in the lost window.

This is the same recovery semantics RFC 6962 Certificate Transparency
logs use: a log that loses its key starts a fresh log; the old log
remains externally verifiable for its full window.

---

## Compromise recovery

If the operator suspects the private key has leaked:

1. **Immediate**: `ccsc audit-key rotate --reason=compromise-suspected`.
   - Rotation event under the old key marks the boundary.
   - From that point, only the new key signs.
2. **Update external gist** with the new public key + a History row
   noting the suspected compromise window and the rotation timestamp.
3. **Notify**: post in the internal CCSC tracking issue (#167 or its
   successor) documenting the rotation. The journal entries from the
   suspected compromise window remain readable but their signatures
   become evidence that *the legitimate writer wrote them*; if an
   attacker forged events under the compromised key, the verifier
   cannot distinguish them. This is the load-bearing limit of
   software-keyed signing without hardware backing.
4. **Optional**: if the threat is severe enough, scrub the affected
   journal window — but doing so erases evidence of what happened
   during the compromise. The default is to keep the window for
   forensic analysis.

---

## What is NOT mitigated

Per `THREAT-MODEL.md` § "Out of scope" and the rollout's risk register
R1 / R10:

- **R1 — false confidence**: a signed audit log is only as trustworthy
  as the keypair's secrecy. An attacker who holds the private key can
  forge events that verify cleanly. Rotation + gist-pinning limit the
  damage window but do not eliminate it. The audit log is a **forensic
  primitive**, not a non-repudiation guarantee.
- **R10 — boot-path failure**: SOPS decryption failures (age key missing
  or wrong, SOPS binary missing, malformed file) cause the bridge to
  exit at boot rather than start in an unsigned state silently. The
  `--no-audit-signing` flag is the emergency valve; it is NEVER the
  default; CI may not start tests with it set (enforced by a test
  asserting the flag is absent from any test command).
- **Same-UID host compromise**: any process running as the session
  owner can read the decrypted key from `/dev/shm` during the window
  it is loaded. This is the existing trust boundary — same-UID
  processes have equal authority by design (see THREAT-MODEL § scope).

---

## References

- [RFC 8032](https://datatracker.ietf.org/doc/html/rfc8032) — *Edwards-Curve Digital Signature Algorithm (EdDSA).* Ed25519 spec.
- [RFC 6962](https://datatracker.ietf.org/doc/html/rfc6962) — *Certificate Transparency.* Rotation + chain-break semantics referenced above.
- [SOPS](https://github.com/getsops/sops) — Secrets OPerationS.
- [age](https://github.com/FiloSottile/age) — modern file encryption.
- [`audit-journal-architecture.md`](audit-journal-architecture.md) — journal v1→v2 schema, verifier semantics (updated by `ccsc-22l`).
- [`THREAT-MODEL.md`](THREAT-MODEL.md) — T11 + invariant #7 (the operational floor this key supports).
- Intent Solutions secrets standard: `~/000-projects/CLAUDE.md` § "SOPS + age secrets standard".

**Bead reference**: `ccsc-c2z`. Blocks `ccsc-22l` (journal v2 signing — needs key location + rotation + recovery decided before signing code lands). Part of the *CCSC Rollout: Admin Commands + Audit/Policy/Governance v2 Cluster* tracked at issue #167.
