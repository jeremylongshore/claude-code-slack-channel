/**
 * nonce-hitl.ts — HMAC nonce + cross-channel HITL primitives (ccsc-ofn).
 *
 * Destructive admin verbs (`!restart`, future `!stop`) carry a real
 * blast radius. The EchoLeak class (CVE-2025-32711, T11 in
 * THREAT-MODEL.md) shows that operators can be tricked or coerced into
 * typing such verbs by message content rendered in a trusted surface.
 * Same-channel verb matching alone — even gated by the allowFrom list
 * — is not sufficient because the same content vector that delivered
 * the verb might also be delivering crafted text that looks like a
 * confirmation prompt response.
 *
 * The mitigation is a **cross-channel handshake**:
 *
 *   1. Operator types `!restart` in channel C.
 *   2. Server mints a 64-bit random nonce, stores it bound to
 *      (userId, originalChannel, expiresAt, consumed=false).
 *   3. Server DMs the nonce to the operator via `chat.postMessage`
 *      with `channel = user_id` — a separate Slack delivery path the
 *      original content vector cannot tamper with.
 *   4. Operator types `!restart <nonce>` in the SAME channel C.
 *   5. Server verifies the nonce: must exist, not be expired, not be
 *      consumed, match the original (userId, channel) tuple. Marks
 *      consumed on success.
 *   6. Server executes the verb.
 *
 * Threat coverage:
 *   - Random-guess attack: 64-bit secret, 60s window → 2^64 / 60s ≈
 *     3.1e17 attempts/sec required to even crack one nonce. Off the
 *     economically-feasible scale.
 *   - Replay attack: single-use enforcement via consumed=true flag.
 *   - Phishing/coercion: the nonce is delivered out-of-band (DM) by
 *     the bot's authenticated identity. An attacker injecting verbs
 *     into channel C cannot also inject the DM. Cross-channel
 *     confirmation is the EchoLeak-class defense.
 *   - Stale-state attack: TTL bounds the window. Default 60s is a
 *     trade between operator UX (long enough to read the DM and
 *     paste the nonce) and adversarial window (short enough that a
 *     compromised state file decays fast).
 *
 * Lives in its own module so the test suite can import the production
 * code path directly. Mirrors the acp-adapter.ts + policy-dispatch.ts
 * pattern from PRs #173 / #178 — pure functions, no boot-time side
 * effects. The DM-delivery step (calling `chat.postMessage`) is NOT
 * in this module — that's server.ts orchestration. This module
 * provides the nonce primitives that the dispatcher composes with
 * the Slack send.
 *
 * SPDX-License-Identifier: MIT
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pending nonce challenge — minted when an operator issues a
 *  destructive admin verb, redeemed when they type the verb again
 *  with the nonce as an argument. */
export interface NonceChallenge {
  /** 16-char lowercase hex string (8 random bytes — 64 bits of
   *  entropy). The bot DMs this verbatim to the operator; the
   *  operator pastes it back into the channel as
   *  `!restart <nonce>`. */
  nonce: string
  /** Slack user_id who triggered the challenge. The redemption MUST
   *  come from the same user — a different operator (even on the
   *  allowFrom list) cannot consume someone else's nonce. */
  userId: string
  /** Slack channel ID where the challenge was issued. The redemption
   *  MUST occur in the same channel — this is the cross-channel
   *  property. The DM channel where the nonce was DELIVERED is a
   *  different channel; pasting the nonce in the DM does NOT redeem
   *  it. */
  channelId: string
  /** Wall-clock ms timestamp after which the nonce is invalid. */
  expiresAt: number
  /** Single-use flag. Once `verifyNonce()` succeeds, this is set to
   *  true and any subsequent verification of the same nonce returns
   *  `replay`. */
  consumed: boolean
}

/** Result of a verification attempt. Always returns — never throws —
 *  so the caller's branching is uniform across success and the
 *  several failure modes. */
export type VerifyResult =
  | { ok: true; challenge: NonceChallenge }
  | { ok: false; reason: 'unknown' | 'expired' | 'replay' | 'wrong-channel' | 'wrong-user' }

/** Storage interface for nonce challenges. The production deployment
 *  uses `createMemoryNonceStore()`; tests can inject a mock or use
 *  the real in-memory store directly. Persisting nonces to disk is
 *  out of scope by design — a restart invalidates pending nonces,
 *  which is the conservative posture (per 000-docs/access-control.md
 *  ccsc-ofn). */
export interface NonceStore {
  set(challenge: NonceChallenge): void
  get(nonce: string): NonceChallenge | undefined
  delete(nonce: string): void
  /** Sweep expired entries. Returns the count removed. Callers should
   *  invoke periodically (e.g., the existing reaper interval). */
  pruneExpired(now: number): number
  /** Diagnostic — number of live entries. Used by metrics; not for
   *  business logic. */
  size(): number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL for a freshly-minted nonce. 60 seconds balances
 *  operator UX (time to read the DM and paste the nonce back) against
 *  adversary window (a compromised state file decays fast). Tunable
 *  per call via `mintNonce(... ttlMs)`. */
export const DEFAULT_NONCE_TTL_MS = 60_000

/** Cap on how many live nonces one user can have in flight at once.
 *  Prevents resource exhaustion: an attacker who could spam the
 *  destructive-verb trigger would otherwise grow the store
 *  unboundedly. Past the cap, the oldest live nonce for that user
 *  is dropped. */
export const MAX_LIVE_NONCES_PER_USER = 3

// ---------------------------------------------------------------------------
// In-memory nonce store
// ---------------------------------------------------------------------------

/** Create a fresh in-memory `NonceStore`. The store is bounded only
 *  by `MAX_LIVE_NONCES_PER_USER`; periodic `pruneExpired()` keeps the
 *  size from drifting. Process restart drops every pending nonce —
 *  intentional. */
export function createMemoryNonceStore(): NonceStore {
  const byNonce = new Map<string, NonceChallenge>()

  return {
    set(challenge) {
      // Enforce per-user cap. Iterate to find this user's live
      // entries; if at the cap, drop the oldest (smallest expiresAt).
      const userEntries: NonceChallenge[] = []
      for (const c of byNonce.values()) {
        if (c.userId === challenge.userId) userEntries.push(c)
      }
      if (userEntries.length >= MAX_LIVE_NONCES_PER_USER) {
        // Sort ascending by expiresAt; oldest is first. Drop it.
        userEntries.sort((a, b) => a.expiresAt - b.expiresAt)
        byNonce.delete(userEntries[0]!.nonce)
      }
      byNonce.set(challenge.nonce, challenge)
    },
    get(nonce) {
      return byNonce.get(nonce)
    },
    delete(nonce) {
      byNonce.delete(nonce)
    },
    pruneExpired(now) {
      let removed = 0
      for (const [nonce, challenge] of byNonce) {
        if (challenge.expiresAt <= now) {
          byNonce.delete(nonce)
          removed += 1
        }
      }
      return removed
    },
    size() {
      return byNonce.size
    },
  }
}

// ---------------------------------------------------------------------------
// mintNonce — issue a fresh challenge
// ---------------------------------------------------------------------------

/** Generate a fresh 16-char hex nonce, register it in `store`, and
 *  return the full challenge for the caller to DM to the operator.
 *
 *  Caller's responsibility: send the returned `nonce` to `userId` via
 *  the out-of-band channel (typically a Slack DM by posting to the
 *  user_id channel). DO NOT send the nonce in the same channel where
 *  the original verb was uttered — that would defeat the cross-channel
 *  property.
 *
 *  Deterministic timing: this function only generates random bytes
 *  and writes to the store. Slack delivery is the caller's concern.
 *
 *  @param userId       Slack user_id of the operator who triggered the verb
 *  @param channelId    Slack channel where the verb was uttered
 *  @param store        The nonce store to register into
 *  @param now          Optional clock — tests inject deterministic time
 *  @param ttlMs        Time-to-live in ms; defaults to DEFAULT_NONCE_TTL_MS
 *  @param rng          Optional RNG — tests inject a deterministic generator
 */
export function mintNonce(
  userId: string,
  channelId: string,
  store: NonceStore,
  now: () => number = (): number => Date.now(),
  ttlMs: number = DEFAULT_NONCE_TTL_MS,
  rng: () => string = (): string => randomBytes(8).toString('hex'),
): NonceChallenge {
  const challenge: NonceChallenge = {
    nonce: rng(),
    userId,
    channelId,
    expiresAt: now() + ttlMs,
    consumed: false,
  }
  store.set(challenge)
  return challenge
}

// ---------------------------------------------------------------------------
// verifyNonce — redeem a challenge
// ---------------------------------------------------------------------------

/** Verify a presented nonce against the store. On success, marks the
 *  challenge consumed and returns the full challenge object (so the
 *  caller can audit/log it). On failure, returns a structured reason.
 *
 *  Failure modes (returned, never thrown):
 *    - `unknown` — no challenge with that nonce exists, or it was
 *      already deleted (e.g., by pruneExpired after a slow operator).
 *    - `expired` — the challenge's expiresAt has passed but pruneExpired
 *      hasn't swept it yet.
 *    - `replay` — the challenge was already consumed by an earlier
 *      verification.
 *    - `wrong-channel` — the presenter is in a different channel than
 *      where the challenge was minted. The cross-channel property
 *      means redemption must be in the same channel as origin.
 *    - `wrong-user` — the presenter is a different Slack user than
 *      who triggered the challenge. Even if they're on the allowFrom
 *      list, they cannot consume someone else's nonce.
 *
 *  Comparison uses `timingSafeEqual` to prevent timing-side-channel
 *  inference of the nonce. The nonce is high-entropy (64 bits), so
 *  timing attacks are not a realistic concern — but defense in depth
 *  is cheap here.
 *
 *  @param presentedNonce  The nonce text the operator typed
 *  @param presentedBy     The (userId, channelId) of the redemption attempt
 *  @param store           The store to look up against
 *  @param now             Optional clock — tests inject deterministic time
 */
export function verifyNonce(
  presentedNonce: string,
  presentedBy: { userId: string; channelId: string },
  store: NonceStore,
  now: () => number = (): number => Date.now(),
): VerifyResult {
  // Lookup is by exact string key; the timing-safe comparison below
  // covers the case where an attacker can probe values close to a
  // valid nonce.
  const challenge = store.get(presentedNonce)
  if (challenge === undefined) {
    return { ok: false, reason: 'unknown' }
  }

  // Constant-time compare. Both strings are 16 hex chars by
  // construction; equal length is the only case timingSafeEqual
  // accepts without throwing.
  if (
    challenge.nonce.length !== presentedNonce.length ||
    !timingSafeEqual(Buffer.from(challenge.nonce, 'utf8'), Buffer.from(presentedNonce, 'utf8'))
  ) {
    // Map mismatch falls into 'unknown' — a partial hex collision is
    // not a meaningful distinction at this entropy.
    return { ok: false, reason: 'unknown' }
  }

  if (challenge.expiresAt <= now()) {
    return { ok: false, reason: 'expired' }
  }
  if (challenge.consumed) {
    return { ok: false, reason: 'replay' }
  }
  if (challenge.userId !== presentedBy.userId) {
    return { ok: false, reason: 'wrong-user' }
  }
  if (challenge.channelId !== presentedBy.channelId) {
    return { ok: false, reason: 'wrong-channel' }
  }

  // All checks passed — mark consumed and return the challenge for
  // audit. Mutates in place: the store's `get` returned a reference
  // to the live entry.
  challenge.consumed = true
  return { ok: true, challenge }
}
