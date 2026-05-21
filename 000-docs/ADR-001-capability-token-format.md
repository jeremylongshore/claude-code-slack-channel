# ADR-001: Capability-token format evaluation

## Status

**DEFERRED** — Evaluated and recommended for future implementation. No second-principal use case exists in CCSC v0.10 rollout. Recommendation locked pending materialization of delegated-operator scenario.

## Context

CCSC implements a tiered policy engine (`admin > user > workspace > default`) that currently authorizes a single principal: the session owner. The architecture explicitly anticipates a second principal — a delegated operator who can be granted scoped, time-bounded, and revocable permission to invoke specific MCP tools without becoming a full session owner.

This capability would enable use cases like:

- A trusted CI/CD system invoking a subset of MCP tools (e.g., Git operations) without owning the session
- An on-call operator executing emergency remediation (e.g., service restart) without full access
- A partner system triggering a specific workflow (e.g., document export) with automatic expiration after 24 hours

The policy engine's design (Epic 29) and supervisor's session isolation (Epic 32) both anticipate this second principal without yet implementing it. This ADR evaluates four candidate token formats for that future delegation scenario, explicitly **deferring a decision** until the use case materializes.

## Decision drivers

1. **Cryptographic primitives in use** — CCSC's audit journal (`journal.ts`, Epic 30) already uses Ed25519 signing. Any new token format should compose well with existing crypto or justify the addition of new primitives.

2. **Verification complexity** — The policy engine must verify delegated authority during tool invocation. Verification must be fast, stateless where possible, and compose cleanly with the existing `evaluate()` decision procedure (Epic 29, `policy.ts`).

3. **Revocation story** — Operators must be able to revoke delegated authority before expiration. Short TTLs alone are insufficient for incident response (e.g., compromised CI/CD token).

4. **Implementation surface** — TypeScript/Node.js libraries must exist and be production-grade. Vaporware or unmaintained libraries are rejection criteria.

5. **Attenuation ergonomics** — The holder should be able to scope-down a token (e.g., reduce tool set, tighten time window) without calling back to the issuer. Offline attenuation is strongly preferred.

6. **Ecosystem fit** — The format should not require new runtime dependencies if CCSC already has equivalent primitives. If new deps are necessary, they must be minimal and actively maintained.

7. **Composability with CCSC's policy engine** — The token must be verifiable within the existing `evaluate()` flow without restructuring the policy evaluation itself.

## Candidate formats

### Macaroons

**TL;DR** — HMAC-based bearer tokens with third-party caveats; delegation via chained MACs; verification is secret-key-dependent but caches beautifully; production-proven at Fly.io at scale.

#### Data structure and delegation

Macaroons are a construction of nested, chained HMACs where each caveat (constraint) is HMAC-authenticated to the prior layer. The issuer creates a root token with a shared secret key (HMAC root key). A holder can add first-party caveats (self-imposed restrictions like time windows or resource scopes) by computing a new HMAC over the prior token and caveat. The result is a bearer token that is cryptographically harder to forge without the root secret.

Delegation works by the holder creating a new Macaroon with tighter caveats (offline), signing it with the root key they don't have (via third-party caveats), and submitting both the original and derivative token to a verifier. The verifier checks the HMAC chain and caveats.

#### Cryptographic primitives

- **HMAC-SHA256** (required; also supports HMAC-SHA512)
- No public-key cryptography; root authority is centralized in a shared secret
- Caveats are plain-text conditions (time ranges, resource paths, etc.)

#### Caveat / attenuation model

**First-party caveats** — The holder adds HMAC-sealed constraints (e.g., `time-before:2026-05-22T12:00:00Z`, `path:/api/deploy`) and signs them into the token. Constraints are verifiable without the root secret.

**Third-party caveats** — The holder delegates caveat discharge to a third party (e.g., an SSO system). The verifier contacts the third party to satisfy the caveat. This enables richer policy logic but requires network calls at verification time.

Offline attenuation is the default. Any party holding a Macaroon can create a derivative with additional caveats without contacting the issuer.

#### Revocation story

Macaroons themselves are not revokable (no built-in revocation list). Revocation is enforced via:

1. **Short TTLs** — Issuer sets tight time-before caveats, forcing periodic re-issuance
2. **Third-party caveat discharge** — Revocation check happens at discharge time (requires network call)
3. **Verification service feed** — Verifier polls an authoritative revocation feed (Fly.io's `tkdb` pattern)

Fly.io's production approach: every Macaroon is tagged with a unique nonce; a centralized token database (`tkdb`) maintains revocation lists and exports a feed of revocation notifications. Clients cache verifications and prune on revocation notification. If a client loses connectivity to `tkdb` past a threshold (e.g., 1 hour), it dumps its verification cache to force re-verification.

#### Implementation surface

**TypeScript/Node.js libraries:**
- [`macaroons.js`](https://github.com/nitram509/macaroons.js) (npm: `macaroons.js@0.3.9`) — TypeScript implementation, compatible with libmacaroons (Go, Python, C). No longer actively developed but receives security updates. Supports binary serialization.
- [`js-macaroon`](https://www.npmjs.com/package/js-macaroon) (npm: `js-macaroon`) — JavaScript implementation, compatible with Go/Python/C. Supports both version 1 and 2 Macaroons, JSON and binary formats. Includes third-party caveat discharger support.
- [`node-macaroons`](https://www.npmjs.com/package/node-macaroons) (npm: `node-macaroons`) — Alias / alternative distribution of the same as above.

**Production use:**
- [Fly.io](https://fly.io) — API tokens, service tokens, machine-scoped delegation. ~5000-line `tkdb` service in Go. Verification cache hit rate >98%. Uses Noise protocol for inter-service communication. Full implementation details in [Operationalizing Macaroons](https://fly.io/blog/operationalizing-macaroons/).

#### Adoption today

- **Fly.io** — Primary production user. Every API token is a Macaroon. Delegation via third-party caveats for SSO integration. Revocation via `tkdb` feed polling.
- **Research / academic** — NDSS 2014 paper, active research community. Security analysis published in peer-reviewed venues.
- **Limited general adoption** — Most organizations use simpler bearer tokens or OAuth2. Macaroons require operationalizing a revocation service for production use.

#### Specific fit for CCSC

**Pros:**
- Offline attenuation (holder can scope down without callback) — exact fit for operator delegation
- Time-window caveats map directly to `--until` flags
- Third-party caveats could integrate with CCSC's existing policy engine (Epic 29)
- HMAC-based verification is stateless (no revocation DB required at verification time, only at issuance time)
- Compatible with Ed25519 audit journal (no crypto-primitive conflict; HMAC is orthogonal)

**Cons:**
- HMAC root key must be shared if multiple CCSC instances verify tokens. Requires external secret storage (Key Vault / Vault).
- No public-key verification; any component with the root key can mint tokens (security perimeter shrinks)
- Third-party caveat discharge requires synchronous verification calls (Fly.io's `tkdb` pattern is operationally complex)
- Revocation story demands a background feed-polling daemon on the verifier side (not trivial)
- JavaScript libraries (`macaroons.js`) are not actively maintained, though security-patched

#### Cryptographic burden

Adding Macaroons to CCSC requires:
- HMAC-SHA256 (already available in Node.js `crypto`)
- Root HMAC key distribution (requires secure storage system)
- Third-party caveat discharger integration (optional but needed for revocation)

No new dependencies if using built-in `crypto`. If using `js-macaroon` npm package, one lightweight dependency introduced.

---

### Biscuits

**TL;DR** — Public-key-based capability tokens with Datalog rules; decentralized verification; offline attenuation via block-chaining; production adoption emerging (Space and Time, Hessra); strong policy expressiveness.

#### Data structure and delegation

Biscuit tokens are signed chains of "blocks" where each block contains Datalog facts, rules, and checks. The root block is signed with an asymmetric keypair (Ed25519 or ECDSA P-256). A holder can append a new block (offline) with additional checks and facts, sign it with their own key, and include the prior block's public key in the signature. Verification walks the chain, checking each signature and executing Datalog rules to determine authorization.

Delegation works by the holder creating a new block with tighter Datalog checks, appending it to their copy of the token, and passing the extended token to the verifier. The verifier validates each block's signature against the public key from the prior block, then evaluates the accumulated Datalog rules.

#### Cryptographic primitives

- **Ed25519** or **ECDSA P-256** (public-key signatures)
- No shared secrets; public keys are embedded in the token itself
- Facts and checks are encoded in Datalog (a logic language)

#### Caveat / attenuation model

**Datalog facts and rules** — Each block can define facts (e.g., `operation("deploy")`), rules (e.g., `can_deploy :- has_role("admin"), time_before("2026-05-22")`) and checks (e.g., `check principal("ci-token-42")`). Verification executes the Datalog engine and checks if authorization queries succeed.

**Block-chain attenuation** — A holder can create a new block with additional checks (e.g., restricting operations, tightening time windows, requiring additional facts) and sign it with their private key. The token is extended, and the new block is only valid if all prior blocks are valid.

Offline attenuation is the default. No network call is needed to scope down a Biscuit; the holder appends and signs a new block.

#### Revocation story

Biscuits support revocation via **revocation IDs** — each block gets a unique ID, and revocation lists are shared with verifiers. When authorizing a Biscuit, the library checks the ID against the revocation list. Revoking a token should also revoke all derived tokens (to prevent circumventing revocation).

A derived token's revocation is implicit: if the parent block's ID is revoked, all derived tokens are invalid. Explicit revocation of just the derived block requires maintaining a revocation list per-block.

#### Implementation surface

**TypeScript/Node.js libraries:**
- [`@biscuit-auth/biscuit-wasm`](https://www.npmjs.com/package/@biscuit-auth/biscuit-wasm) (npm: `@biscuit-auth/biscuit-wasm@0.6.0-beta.1+`) — WebAssembly build of the Rust Biscuit library, published to npm. CommonJS and ES modules. Full TypeScript definitions. Express middleware support.
- [Rust source](https://github.com/eclipse-biscuit/biscuit-rust) — If embedding Rust computation is feasible (not typical in a Node.js Slack bridge).

**Production use:**
- [Space and Time](https://www.spaceandtime.io/blog/biscuit-authorization) — Authorization for decentralized SQL query engine. Public blog post on Biscuit adoption.
- [Hessra](https://www.hessra.net/) — Identity and authorization service built around Biscuits as alternative to JWTs (Hacker News discussions indicate early production).
- **Limited but growing** — Eclipse Foundation project; Datalog-based security is still niche.

#### Adoption today

- **Space and Time** — Production authorization for resource access
- **Hessra** — Early production identity / authorization service
- **Research** — Growing academic and security-community interest
- **General adoption** — Substantially lower than Macaroons; Datalog-based policy is less familiar to typical engineers

#### Specific fit for CCSC

**Pros:**
- Public-key verification (no shared secret needed; each token is self-verifying)
- Datalog rules are expressive and composable with CCSC's tiered policy engine (Epic 29)
- Offline attenuation (holder can add blocks without callback)
- Revocation via block IDs is explicit and decentralized
- No new cryptographic primitives (Ed25519 is already in the audit journal)
- WebAssembly / npm distribution (`@biscuit-auth/biscuit-wasm`) makes integration straightforward

**Cons:**
- Datalog is unfamiliar to most engineers; policy debugging requires learning a new language
- Revocation-list distribution and staleness are non-trivial (requires a background revocation-list feed, similar to Macaroons)
- `@biscuit-auth/biscuit-wasm` is beta (v0.6.0-beta.1); no stable 1.0 release yet as of 2026-05-01
- Derived-token revocation requires careful tracking (revoking a parent automatically revokes children, but revoking just the child requires explicit list entries)
- WASM initialization adds startup latency (though typically <10ms)

#### Cryptographic burden

Adding Biscuits to CCSC requires:
- Ed25519 or P-256 (CCSC already has Ed25519 for audit journal; P-256 is new)
- Datalog engine (included in the WASM library; no external dep)
- Revocation list feed (requires background polling or push notifications)

One new npm dependency: `@biscuit-auth/biscuit-wasm`. No new cryptographic algorithms if using Ed25519 (already in use).

---

### UCAN

**TL;DR** — DID-based JWT-shaped tokens with capability delegation; decentralized, content-addressed, IPFS-friendly; production at Storacha; strong fit for distributed systems; public-key verification.

#### Data structure and delegation

UCANs are JWTs with additional required and optional fields for capability-based authorization. Each UCAN encodes:

- **Issuer** (did:key of the issuer)
- **Audience** (did:key of the recipient)
- **Subject** (the principal whose authority is delegated; may differ from issuer)
- **Capabilities** (which actions on which resources are authorized)
- **Delegation chain** — proofs of prior delegations (embedded as JWT chains)
- **Time bounds** (nbf/exp Unix timestamps)

Delegation works by creating a new UCAN with the issuer's did:key as the subject, signing it with the issuer's private key, and passing it to the audience. The audience can verify the signature and check the delegation chain. Further delegation is possible by creating a new UCAN with the audience as issuer, the new audience as receiver, and the prior UCAN in the delegation proof field.

#### Cryptographic primitives

- **Ed25519**, **P-256**, or **secp256k1** (public-key signatures; Ed25519 is recommended)
- **Decentralized Identity (did:key)** — encodes public key into a compact string (e.g., `did:key:z6MkhaXgBZDvotBfKd…`)
- **DAG-CBOR** encoding (content-addressed, immutable)
- **CIDv1** with SHA-256 for content addressing

#### Caveat / attenuation model

**Capabilities format** — Each capability is a JSON object with `can` (action), `with` (resource URI), and optional `nb` (not-before) and `ex` (expiration) timestamps. Attenuation works by creating a new UCAN with a narrower capability set (fewer actions, fewer resources, tighter time windows).

**Delegation chain** — A UCAN includes all prior delegation UCANs as proofs. The verifier walks the chain, checking each signature, to reconstruct the full authorization lineage. This enables trustless verification without a central authority.

Offline attenuation is the default. The holder creates a new UCAN delegating from their own did:key to the receiver's did:key, with reduced capabilities.

#### Revocation story

UCAN revocation is achieved by publishing an unforgeable revocation message from a delegator stating that a specific delegation path (identified by the prior UCAN's CID) is no longer valid. Revocation is **block-list based** — verifiers maintain a list of revoked CIDs and check every UCAN's CID against it before accepting delegation.

Revocation is asynchronous: a verifier may not see a revocation message immediately, so short TTLs are combined with periodic revocation-list checks. Storacha's production approach is to distribute revocations via DHT (Distributed Hash Table), allowing verifiers to query the network for revocation status.

#### Implementation surface

**TypeScript/Node.js libraries:**
- [ts-ucan](https://github.com/ucan-wg/ts-ucan) (GitHub, npm: [`ucan`](https://www.npmjs.com/package/ucan)) — Official TypeScript implementation, maintained by the UCAN Working Group. Full support for capability encoding, delegation, invocation, and revocation. **Note:** Package name `ucan` on npm.
- [ucanto](https://github.com/web3-storage/ucanto) (npm: `@ucanto/core` + related) — Fission's RPC framework built on UCAN for distributed authorization. More heavyweight; includes transport layer.

**Production use:**
- [Storacha](https://storacha.network) — Decentralized hot storage network. UCANs are the primary authorization mechanism. Permissionless participation planned for early 2025. Full integration with Filecoin + IPFS.
- [NFT.storage](https://nft.storage) — (now Storacha) — UCAN-based delegation for NFT metadata storage.
- **IPFS ecosystem** — UCAN is the canonical authorization format for content-addressed, decentralized systems.

#### Adoption today

- **Storacha / NFT.storage** — Production authorization for decentralized storage
- **Web3 storage services** — UCANs are the standard for IPFS-integrated systems
- **Fission** — Original proposers and early implementers
- **General adoption** — Moderate; primarily in Web3/IPFS ecosystems. Not yet mainstream in centralized systems.

#### Specific fit for CCSC

**Pros:**
- Public-key verification (self-contained; no shared secret or revocation-service dependency for verification)
- Strong composability with distributed systems (Storacha reference implementation is production-grade)
- Content-addressed (CIDv1) enables tamper detection and auditable lineage
- Offline attenuation and delegation are first-class
- Ed25519 is already in CCSC's audit journal
- Revocation is explicit (block-list style) and decentralized

**Cons:**
- JWT-based format is not optimized for frequent issuance (UCAN JWTs are larger than Biscuit or Macaroon tokens)
- did:key is unfamiliar to most engineers; spec reading is required for integration
- Revocation-list distribution requires a DHT or gossip protocol (Storacha pattern is complex)
- No Express middleware or middleware-library equivalents for Node.js backends (less integration-friendly than Biscuits)
- DAG-CBOR encoding may require additional dependencies (though @ucanto/core includes it)
- IPFS/Web3 context may feel overscoped for a Slack bridge use case

#### Cryptographic burden

Adding UCANs to CCSC requires:
- Ed25519 (already in audit journal)
- DAG-CBOR encoding (typically via `@ipld/dag-cbor` or equivalent)
- did:key encoder/decoder (typically via `did-resolver` or `key-did-resolver`)

Two lightweight npm dependencies: `ucan` (official) and `@ipld/dag-cbor`. No new cryptographic algorithms.

---

### DPoP-bound JWT

**TL;DR** — RFC 9449 OAuth 2.0 standard; binds access tokens to a client's public key via short-lived proof JWTs; prevents token theft via sender-constraining; production adoption in OAuth2 ecosystems (Okta, Auth0); complex bearer-token protocol.

#### Data structure and delegation

DPoP (Demonstrating Proof-of-Possession) is not a token format itself but a **binding mechanism** for access tokens. It works in tandem with OAuth2:

1. Client generates an asymmetric keypair (typically P-256 ECDSA, or Ed25519)
2. Client requests an access token, including a DPoP proof JWT signed with the private key
3. Authorization server issues an access token bound to the client's public key
4. On every resource request, the client includes:
   - The access token (as a bearer token)
   - A fresh DPoP proof JWT signed with the same private key, containing the request method, URL, and timestamp

The resource server verifies both the access token and the DPoP proof. The proof is short-lived (typically 60 seconds) and tied to the specific request. A stolen access token alone is useless without the corresponding private key.

Delegation in the DPoP model is not as direct as Macaroons or Biscuits. A client can delegate by issuing a new access token and proof to another party, but the new token is bound to that party's public key. DPoP is primarily a **sender-constraining mechanism**, not a **capability delegation format**.

#### Cryptographic primitives

- **ECDSA P-256** (recommended; also Ed25519, RSA)
- **JWT format** (RS256, ES256, EdDSA per RFC 8037)
- **Asymmetric key pairs** (client holds private key; server verifies against public key)

#### Caveat / attenuation model

DPoP does **not** support offline attenuation. The bearer token itself does not encode capabilities or constraints; constraints (scopes, resource URIs) come from the OAuth2 **scope** parameter negotiated at token-issuance time.

If a client wishes to delegate with reduced scope, it must request a new token from the authorization server with the narrower scope. This is a **network-dependent** operation, not offline attenuation.

Delegation is possible but not convenient: the original token cannot be attenuated; a new token must be issued. Multiple parties cannot hold the same token and independently scope it down.

#### Revocation story

DPoP tokens are revoked via standard OAuth2 mechanisms:

1. **Token revocation endpoint** — Client can call the authorization server's revocation endpoint with the token
2. **Token expiration** — Short TTLs (typically 1 hour) force periodic re-issuance
3. **Revocation lists** — Authorization server maintains a list of revoked token IDs (optional, less common)

Revocation is immediate if the authorization server maintains a revocation list. Without a list, revocation is enforced only by short TTLs and exfiltration detection (e.g., unusual client behavior).

DPoP adds **proof-of-possession binding** but does not improve revocation; revocation still depends on OAuth2's standard mechanisms.

#### Implementation surface

**TypeScript/Node.js libraries:**
- [`dpop`](https://www.npmjs.com/package/dpop) (npm: `dpop@2.1.1`) — DPoP for JavaScript runtimes. Node.js ^20.19.0 || ^22.12.0 || >=23.0.0. CommonJS and ESM. Minimal dependencies.
- [`@panva/dpop`](https://github.com/panva/dpop) — Alternative production library, also actively maintained.
- [`jose`](https://www.npmjs.com/package/jose) — General-purpose JWT library with DPoP support for both frontend and backend.
- **OAuth2 server libraries** — express-oauth2-jwt-bearer (Auth0), okta-sdk (Okta) support DPoP server-side validation.

**Production use:**
- **Okta** — DPoP support for API token binding. Okta SDK provides DPoP helpers.
- **Auth0** — Production DPoP support and documentation.
- **IETF OAuth2 ecosystem** — RFC 9449 standardized in September 2023; adoption is growing in OAuth2-heavy organizations (enterprises, cloud platforms).

#### Adoption today

- **Okta** — Enterprise OAuth2 provider; DPoP support announced and documented
- **Auth0** — DPoP support; active documentation and integration guides
- **IETF OAuth2 community** — Standard track; adoption is increasing
- **General adoption** — Growing in OAuth2 ecosystems; still niche outside of enterprise identity

#### Specific fit for CCSC

**Pros:**
- RFC 9449 is a published IETF standard (stable, not research)
- Prevents token theft by binding to client's private key (strong defense against exfiltration)
- Wide ecosystem support (Auth0, Okta, IETF libraries)
- Simple to implement in Node.js (minimal dependencies via `dpop` or `jose`)
- Production-proven in enterprise OAuth2 systems

**Cons:**
- **Does not support offline attenuation** — A holder cannot scope down a token without calling back to the issuer. This is a critical mismatch with CCSC's requirement for delegated operators to independently restrict permissions.
- Not a capability-token format; it's a **bearer-token binding mechanism**. Capabilities are still managed via OAuth2 scopes (orthogonal to DPoP itself).
- Requires an authorization server (implicit in OAuth2 flow) — CCSC would need to implement token issuance, revocation endpoints, and scope management. Significant added complexity.
- DPoP proofs are short-lived (60–120 s); every request requires a new proof JWT. This adds per-request latency.
- Token-binding model is asymmetric: a DPoP-bound token cannot be delegated to a third party without also transferring the private key (breaking the binding).
- Revocation story is standard OAuth2 (not improved by DPoP); CCSC would still need a revocation endpoint.

#### Cryptographic burden

Adding DPoP to CCSC requires:
- ECDSA P-256 or Ed25519 (Ed25519 is already in audit journal; P-256 is new)
- JWT encoding/decoding (available via `jose` or `dpop` npm packages)
- OAuth2 token-issuance and revocation endpoints (architectural; not just cryptographic)

One lightweight npm dependency: `dpop` or `jose`. However, the architectural burden is substantial: CCSC would need to become an OAuth2 authorization server, complete with token endpoints, revocation endpoints, scope negotiation, and client registration. This is a large expansion of the system's scope.

---

## Recommendation

### First-choice format: **Biscuits**

If CCSC had to ship delegated-operator authorization today, **Biscuits** would be the first choice.

**Why Biscuits:**

1. **Offline attenuation** — Holders can scope down tokens without calling back to CCSC, exactly matching the use case (operator delegates to a CI/CD system with narrower permissions)
2. **Public-key verification** — No shared secret required; each token is self-verifying via Ed25519 signatures
3. **Datalog rules are expressive** — The policy engine can directly evaluate Biscuit checks against CCSC's existing tiered policy (Epic 29). A Biscuit block can encode `check principal("ci-token-42"); check operation_in(["deploy", "restart"]); check time_before("2026-05-22")`. The policy engine queries this via Datalog.
4. **Decentralized revocation** — Revocation is via block IDs (content-addressed), not a central service. Compatible with CCSC's stateless verification assumption.
5. **Minimal new crypto** — Ed25519 is already in the audit journal; no new primitives.
6. **Strong composition with existing architecture** — Supervisor (Epic 32) can bind Biscuit tokens to session keys; policy engine (Epic 29) can evaluate Biscuit checks as additional authorization conditions.

**Single biggest risk:** `@biscuit-auth/biscuit-wasm` is beta (v0.6.0-beta.1 as of 2026-05-01). Stability risk is real. Mitigation: pin the version aggressively and establish a dependency-update SLO (e.g., ship a patch within 7 days of Biscuit WASM releases).

**Single biggest risk of NOT choosing Biscuits:** Falling back to Macaroons requires Fly.io's `tkdb` operational pattern (a separate revocation service, secret-key management, third-party caveat discharge). That is significantly more complex. UCAN is Web3-forward (not wrong, but adds unfamiliarity). DPoP doesn't support offline attenuation at all.

### Rollout plan

**NO SHIP of delegated-operator tokens in v0.10 — this is locked per Epic 29 decision #10.** Biscuits remain the recommended choice for when the use case materializes:

1. **v0.10 (current)** — Policy engine ships with single-principal authorization (session owner only). Token format decision deferred.
2. **Future release (v0.11+, TBD)** — When a real operator-delegation use case appears (e.g., CI/CD integration request), file an epic to implement Biscuit-based delegation:
   - Supervisor adds `DelegatedOperator` principal type
   - Policy engine's `evaluate()` accepts Biscuit proofs alongside session owner checks
   - Operator-delegation token issuance endpoint added to `/slack-channel:configure` skill
   - Token revocation via block ID integrated into auditing (Epic 30)
3. **Migration strategy** — No migration needed; this is purely additive. Existing single-principal sessions continue unchanged.

### Rationale for deferral

The project's current scope includes:

- Single-principal authorization (session owner)
- Tiered policy (admin / user / workspace / default)
- Audit journal with Ed25519 signing
- Per-thread session isolation

None of these require multi-principal capability tokens. Adding them now would:

- Introduce new npm dependencies and cryptographic complexity
- Add integration surface in the policy engine before use cases are concrete
- Require operational burden (revocation-list management, key rotation) without justifying ROI

**Deferred is the right call.** Biscuits are ready when the use case is.

## Consequences

### If Biscuits are adopted in a future release

- **Positive:**
  - Operators gain scoped, time-bounded, revocable authority without becoming session owners
  - Offline attenuation enables federated delegation (operator → CI/CD → agent, each narrowing scope)
  - Audit journal inherits Biscuit block signatures (chain of custody)
  - No new cryptographic algorithms (Ed25519 already in use)
  
- **Negative:**
  - `@biscuit-auth/biscuit-wasm` beta stability risk (requires vigilant dependency management)
  - Datalog debugging is unfamiliar to most engineers (training / documentation required)
  - Revocation-list distribution adds background task complexity
  - Token verification adds startup latency (WASM initialization, though typically <10ms)

### If this decision is deferred indefinitely

- **Positive:**
  - CCSC remains simpler (single principal, fewer moving parts)
  - No dependency on beta libraries
  - Simpler revocation story (session lifetime = token lifetime)

- **Negative:**
  - Operator delegation use cases cannot be supported
  - Any future multi-principal architecture must re-evaluate (may lock in suboptimal choices if done ad-hoc)
  - Competitive disadvantage if similar systems offer delegation

### If a different format is chosen later

- **Macaroons:** Operationally heavier (revocation service required), but production-proven at Fly.io scale. Feasible if CCSC grows to require the caching benefits (98% hit rate).
- **UCAN:** Stronger fit for distributed / IPFS-adjacent systems. Overkill for centralized Slack bridge unless future roadmap pivots toward Web3.
- **DPoP:** Unsuitable due to lack of offline attenuation. Revisit only if architecture pivots to OAuth2-based token issuance (major redesign).

## References

### Macaroons

- Birgisson, A., Politz, J. G., Erlingsson, Ú., Taly, A., Vrable, M., & Lentczner, M. (2014). "Macaroons: Cookies with Contextual Caveats for Decentralized Authorization in the Cloud." *Network and Distributed System Security (NDSS) Symposium*, San Diego, CA. [Google Research](https://research.google/pubs/pub41892/)
- Fly.io. (2024). ["Operationalizing Macaroons"](https://fly.io/blog/operationalizing-macaroons/). *The Fly Blog*.
- Fly.io. (2024). ["Macaroons Escalated Quickly"](https://fly.io/blog/macaroons-escalated-quickly/). *The Fly Blog*.
- Fly.io. (2022). ["API Tokens: A Tedious Survey"](https://fly.io/blog/api-tokens-a-tedious-survey/). *The Fly Blog*.
- Nitram509. ["macaroons.js: JavaScript implementation of Macaroons"](https://github.com/nitram509/macaroons.js). GitHub. npm: [`macaroons.js`](https://www.npmjs.com/package/macaroons.js).
- go-macaroon. ["js-macaroon: Javascript implementation of macaroons"](https://github.com/go-macaroon/js-macaroon). GitHub. npm: [`js-macaroon`](https://www.npmjs.com/package/js-macaroon).

### Biscuits

- Eclipse Foundation. [Eclipse Biscuit](https://www.biscuitsec.org/). Official project site.
- eclipse-biscuit. ["biscuit-rust: Rust implementation of the Biscuit authorization token"](https://github.com/eclipse-biscuit/biscuit-rust). GitHub.
- biscuit-auth. ["@biscuit-auth/biscuit-wasm: WebAssembly implementation for Node.js"](https://www.npmjs.com/package/@biscuit-auth/biscuit-wasm). npm.
- Eclipse Biscuit. [Documentation: NodeJS](https://doc.biscuitsec.org/usage/nodejs.html).
- Space and Time. (2024). ["Biscuit Authorization"](https://www.spaceandtime.io/blog/biscuit-authorization). *Space and Time Blog*.
- Malmgren, P. ["Notes on Biscuits for Authentication"](https://petermalmgren.com/biscuitsec-0/). Peter Malmgren's blog.
- Eclipse Biscuit. [Revocation](https://www.biscuitsec.org/docs/guides/revocation/). Official documentation.

### UCAN

- UCAN Working Group. [UCAN Specification](https://github.com/ucan-wg/spec). GitHub.
- UCAN Working Group. [ts-ucan: TypeScript implementation](https://github.com/ucan-wg/ts-ucan). GitHub. npm: [`ucan`](https://www.npmjs.com/package/ucan).
- Storacha. ["UCAN: User controlled authorization networks"](https://docs.storacha.network/concepts/ucan/). Storacha documentation.
- Storacha. ["UCANs and Storacha"](https://docs.storacha.network/concepts/ucans-and-storacha/). Storacha documentation.
- NFT.storage. ["Use UCAN tokens for delegated authorization"](https://dev.nft.storage/docs/how-to/ucan/). NFT.storage documentation (now Storacha).
- Fission. [Ucanto: RPC framework built on UCAN](https://github.com/web3-storage/ucanto). GitHub.
- UCAN. [Revocation Specification](https://ucan.xyz/revocation/). Official UCAN revocation spec.

### DPoP

- IETF. [RFC 9449: OAuth 2.0 Demonstrating Proof of Possession (DPoP)](https://datatracker.ietf.org/doc/html/rfc9449). Published September 2023.
- OAuth.net. [OAuth 2.0 DPoP](https://oauth.net/2/dpop/). Reference guide.
- panva. ["dpop: DPoP for Web Platform API JavaScript runtimes"](https://github.com/panva/dpop). GitHub. npm: [`dpop`](https://www.npmjs.com/package/dpop).
- jose contributors. ["jose: JSON Web Signature and Encryption (JWE/JWS) in Node.js with DPoP support"](https://www.npmjs.com/package/jose). npm.
- Auth0. ["Implementing DPoP with Auth0"](https://auth0.com/blog/implementing-dpop-with-auth0/). *Auth0 Blog*.
- Auth0. ["Demonstrating Proof-of-Possession (DPoP)"](https://auth0.com/docs/secure/sender-constraining/demonstrating-proof-of-possession-dpop). Auth0 documentation.
- WorkOS. ["DPoP (RFC 9449) explained: How sender-constrained OAuth tokens make token theft a non-event"](https://workos.com/blog/dpop-rfc-9449-explained). *WorkOS Blog*.
- Self-Issued. ["RFC 9449: OAuth 2.0 Demonstrating Proof of Possession (DPoP) is now RFC 9449"](https://self-issued.info/?p=2417). Mike Jones blog.

### Related work and frameworks

- Malmgren, P. ["Biscuits - A tasty solution for AuthZ"](https://er4hn.info/blog/2024.05.08-biscuits/). Security blog.
- Madden, N. ["Introduction to Macaroons"](https://handouts.secappdev.org/handouts/2024/neilmadden_introduction-to-macaroons.pdf). SecAppDev 2024 Handout (PDF).
- tank, G. ["Macaroons Reading List"](https://blog.gtank.cc/macaroons-reading-list/). Reference list.
- Medium. ["Capability-Based Security and Macaroons"](https://medium.com/swlh/capability-based-security-and-macaroons-aaa64fb9fc01). Survey article.
- AuthGear. ["Demonstrating Proof-of-Possession (DPoP): A Complete Guide for Modern OAuth Security"](https://www.authgear.com/post/demonstrating-proof-of-possession-dpop/). Tutorial.
