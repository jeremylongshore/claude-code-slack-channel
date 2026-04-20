/**
 * manifest.ts — Peer-bot manifest schema (Epic 31-A).
 *
 * A manifest is a JSON payload that a peer agent posts in-channel to advertise
 * what it is: name, vendor, version, tools it exposes, channels it opts into,
 * and a contact address. Other bots and humans read manifests as *information*;
 * they are advertisements, never grants (Miller 2006, Robust Composition).
 *
 * This file intentionally has no imports from `policy.ts` or `lib.ts`'s
 * policy-adjacent surface. The symmetric constraint — `policy.ts` does not
 * import from this module — is enforced by the 31-A.4 invariant test in
 * `server.test.ts`. See `000-docs/bot-manifest-protocol.md` §91-109 for the
 * binding invariant and §17-55 for the on-wire schema this file encodes.
 *
 * Scope of this file for ccsc-s53.1:
 *   - The `ManifestV1` Zod schema with magic-header discriminator.
 *   - Inferred TypeScript type.
 *
 * Sibling beads add: size cap (s53.3), the `read_peer_manifests` MCP tool
 * (s53.2), and the 5-minute per-channel read cache (s53.5).
 *
 * SPDX-License-Identifier: MIT
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// ManifestV1 — on-channel advertisement schema
// ---------------------------------------------------------------------------

/**
 * SemVer 2.0.0 subset accepted for `version`: `MAJOR.MINOR.PATCH` with an
 * optional pre-release suffix `-<alnum/dot/hyphen>`. Build metadata (`+…`)
 * is deliberately excluded — manifests that want to signal a build should
 * surface it via `description`, not the version field. Keeping the regex
 * narrow means downstream consumers that want to sort manifests can do so
 * without a full SemVer parser.
 */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/

/**
 * Slack public-channel ID shape. `C` + uppercase alphanumerics. DM IDs
 * (`D…`) and private-group IDs (`G…`) are deliberately rejected — a
 * manifest advertising participation in a DM or private group would leak
 * non-public information about the bot's reach and is out of scope for
 * the v1 protocol.
 */
const CHANNEL_ID_RE = /^C[A-Z0-9]+$/

/**
 * Zod schema for the v1 manifest payload.
 *
 * The literal `__claude_bot_manifest_v1__: true` property doubles as a
 * version discriminator: future protocol revisions will mint a new key
 * (e.g. `__claude_bot_manifest_v2__`) so consumers that understand only
 * v1 can skip unknown versions without false-matching them. Matches the
 * frozen contract in `000-docs/bot-manifest-protocol.md` §24-41.
 *
 * Validation failures (malformed JSON, missing fields, wrong types, size
 * cap violations, or the magic header missing / not literally `true`) are
 * silently dropped by the consumer — see the protocol doc §81 and bead
 * ccsc-s53.13 ("Drop malformed, invalid, and oversized manifests
 * silently"). This file only encodes the *shape*; the dropping happens in
 * the read tool (ccsc-s53.2) and the size-cap layer (ccsc-s53.3).
 */
export const ManifestV1 = z.object({
  __claude_bot_manifest_v1__: z.literal(true),
  name: z.string().min(1).max(80),
  vendor: z.string().min(1).max(80),
  version: z.string().regex(SEMVER_RE),
  description: z.string().max(1000),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(400),
      }),
    )
    .max(50),
  channels: z.array(z.string().regex(CHANNEL_ID_RE)).max(50).optional(),
  contact: z.string().email().optional(),
  publishedAt: z.string().datetime(),
})

/** Inferred type for a validated manifest payload. */
export type ManifestV1 = z.infer<typeof ManifestV1>

/**
 * The magic header key. Exported so the read tool (ccsc-s53.2) and any
 * pins.list discriminator can match on the same literal without repeating
 * the string. Consumers MUST check that the key's value is exactly `true`
 * before trusting the payload to be a v1 manifest — presence alone is not
 * enough (a peer could post `{"__claude_bot_manifest_v1__": "yes"}` and
 * that must not match).
 */
export const MANIFEST_V1_MAGIC_KEY = '__claude_bot_manifest_v1__' as const

// ---------------------------------------------------------------------------
// extractManifests — pure filter/parse/validate for a batch of message texts
// ---------------------------------------------------------------------------

/**
 * Cheap pre-filter: does a message body syntactically mention the magic
 * header key? Used to short-circuit the parse step for the overwhelming
 * majority of messages that are not manifest payloads. A false positive
 * here (message body that coincidentally contains the key string in
 * prose) is caught by `JSON.parse` or Zod on the next step — this is
 * purely a perf filter, never a trust signal.
 */
function looksLikeManifest(text: string): boolean {
  return text.includes(MANIFEST_V1_MAGIC_KEY)
}

/**
 * Extract every valid v1 manifest from a batch of message texts (Epic
 * 31-A.2, bead ccsc-s53.2). The flow is:
 *
 *   1. skip null / undefined / non-string bodies
 *   2. cheap string-includes filter on the magic header key
 *   3. `JSON.parse` — silent drop on any throw
 *   4. `ManifestV1.safeParse` — silent drop on any Zod error
 *
 * "Silent drop" is the doc's chosen posture (§81, §255) for
 * malformed/invalid manifests: a peer posting garbage must not break the
 * consumer, and there is no caller-visible error channel because this is
 * advertising, not an API. Operators get ground truth via the 30-A
 * journal when the read tool logs the read event — per-message drop
 * details are intentionally not surfaced.
 *
 * Size cap (40 KB per raw body) is a sibling bead (ccsc-s53.3); this
 * function does not enforce it. Callers that receive potentially large
 * bodies must pre-filter before calling, or wait for s53.3 to layer
 * that in.
 *
 * Returns validated manifests in the order they appeared in the input.
 * Duplicate de-dup is NOT performed here — a channel that has the same
 * peer's manifest pinned AND in the last 50 messages will surface both
 * copies, and the caller (or Claude reading the tool output) decides
 * what to do with the duplication. Keeping this function position-
 * preserving and non-deduping makes it trivially testable.
 */
export function extractManifests(
  texts: ReadonlyArray<string | null | undefined>,
): ManifestV1[] {
  return texts.flatMap((text) => {
    if (typeof text !== 'string' || text.length === 0) return []
    if (!looksLikeManifest(text)) return []
    try {
      const parsed: unknown = JSON.parse(text)
      const result = ManifestV1.safeParse(parsed)
      return result.success ? [result.data] : []
    } catch {
      return []
    }
  })
}
