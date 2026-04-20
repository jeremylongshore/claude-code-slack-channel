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
