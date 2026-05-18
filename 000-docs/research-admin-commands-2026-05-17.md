# Findings — Admin Commands + Operator Control (2026-05-17 research pass)

Tracking bead: `ccsc-d7l`. Originating PR: `gog5-ops/claude-code-slack-channel#157` (self-closed after Gemini review). Research executed across three parallel lanes — academic literature (Semantic Scholar), open-source ecosystem (WebSearch / `gh`), and security/audit/UX (WebSearch / WebFetch).

## TL;DR

The three options proposed earlier do not survive the literature unchanged. **The current PR shape — `!clear` / `!restart` over `execSync` + tmux `send-keys`, gated only by a Slack-user-id allowlist — concentrates the highest-blast-radius operations behind the weakest auth primitive in the system, in a year when concrete CVSS-9.3 production exploits (EchoLeak, CVE-2025-32711) have demonstrated that "trusted-channel" messages routinely carry CLI-equivalent instructions through agent surfaces.** The evidence converges on a fourth option: route admin commands through the existing policy engine as typed `admin.*` events, emit `session.quiesce` / `session.deactivate` via the supervisor (already wired into `EventKind`), and refuse any shell-exec authority on the Slack side. Any operator-local tmux clearing belongs on the operator's own box, never reachable through the bridge. Recommendation: **Option 4 (below). Do not merge PR #157 as-written, even with the Gemini hardening.**

## Patterns we already have (don't reinvent)

| Pattern | Our primitive | Ecosystem analog | Citation |
|---|---|---|---|
| **Session-level state machine mediating every tool invocation** | `SessionSupervisor` interface (`supervisor.ts:139-167`) — `activate / quiesce / deactivate` with strict FSM (`supervisor.ts:68`) | MCP-Secure (Singh & Madisetti, 2026) describes the same architecture as "host-side enforcement layer for MCP applying scoped access, read-only defaults, approval-gated privilege elevation" | IEEE Open J. CS, 2026, paperId `dae70c05578f62eab9618d07aa6f5ed6bfd0e9a4` |
| **Pre-execution policy evaluation** | `policy.evaluate()` runs *before* the MCP tool fires; declarative rules, Zod schema | AEGIS (Yuan, Su, Zhao, 2026) names the three-stage pipeline "extract → scan → validate" — direct competitor to our `evaluate()` factoring | arXiv, 2026, paperId `c67408b6affa8d47e7bd1cf82798eea8a59fde4c` |
| **Hash-chained tamper-evident audit log** | `journal.ts` writer with `prevHash` + `hash` per event (`journal.ts:25-27`), 22-variant `EventKind` discriminated union (`journal.ts:60-89`) | AuditableLLM (MDPI Electronics 15/1, 2026); EventSourcingDB; SEC Rule 17a-4 acceptance of hash-chains; Right to History (Zhang, 2026) with Merkle inclusion proofs as the next-tier upgrade | https://www.mdpi.com/2079-9292/15/1/56 ; arXiv paperId `dc9fb3c506e5242512fe076fa89a49a48d5652ae` |
| **Inbound gate with self-echo detection and permission-reply matching** | `gate()` in `lib.ts:1230` — five-block decision (bot opt-in, subtype filter, user-id check, DM handler, channel handler at `lib.ts:1213-1228`) | EchoLeak (CVE-2025-32711) demonstrates that gate-discipline must precede the agent loop, not happen inside it — our shape is correct | arXiv 2509.10540 ; https://www.varonis.com/blog/echoleak |
| **Four-principal model + redacted journal events** | `Actor` enum (`journal.ts:109-116`): `session_owner` / `claude_process` / `human_approver` / `peer_agent` / `system` | OpenHands EventStream — every action and observation is a structured event with source attribution | https://docs.openhands.dev/sdk/arch/events |
| **Cooperative session interrupt vocabulary** | `supervisor.quiesce(key)` — "refuse new work, flush pending writes" (`supervisor.ts:169-182`); cancelable by inbound event (§124 of session-state-machine.md) | Agent Client Protocol's `session/cancel` notification — cooperative interrupt, agent acknowledges with `cancelled` stop reason. Adopted by Zed, requested in google/adk-python#2425 | https://agentclientprotocol.com/protocol/prompt-turn |

**Takeaway:** every load-bearing pattern from the 2025-2026 literature already has a counterpart in this codebase. The gap is not architectural — it is that PR #157 attempts admin-command surfaces *outside* these primitives instead of routing through them.

## Patterns we're missing (or under-leveraging)

| Gap | Why it matters | Cost to adopt | Citation |
|---|---|---|---|
| **Admin commands as typed events, not Slack handlers** | OpenHands' EventStream and the "Chat-is-transport-not-auth-domain" pattern (Rundeck / StackStorm / Ansible Tower) all converge: the chat surface dispatches a *named, pre-approved action* — it never executes intent directly. PR #157 has `!clear` and `!restart` as hand-coded handlers in `server.ts`, bypassing both `policy.evaluate()` and `journal.ts`. | **Low.** Adds two `EventKind` entries (`admin.clear`, `admin.restart`), two virtual tools in `policy.ts`, a thin dispatcher. ~1-2 days. | https://docs.openhands.dev/sdk/arch/events ; https://docs.rundeck.com/docs/learning/solutions/automated-diagnostics/integrating-chat-tools.html ; https://docs.stackstorm.com/chatops/chatops.html |
| **Privileged transitions written with `{actor, prior_chain_head_hash, command_nonce, reason}`** | The CT signed-checkpoint pattern + AuditableLLM's hash-chain spec converge on the same shape: every privileged transition (reset, halt, key-rotate) is a regular event in the existing chain, with full context embedded. We have the chain; we don't yet include `command_nonce` or explicit prior-chain-head reference on admin transitions. | **Low.** Schema addition + 20 LoC in the writer; verifier already walks the chain. | RFC 6962 https://datatracker.ietf.org/doc/html/rfc6962 ; https://www.mdpi.com/2079-9292/15/1/56 |
| **Per-action HMAC nonce or DPoP-bound capability** | 93% of agent projects still use unscoped API keys / identity-only allowlists (Strata 2026 survey). The corrective pattern is short-lived per-action proofs. PR #157 relies entirely on Slack-user-id allowlist — the weakest auth primitive available, identical in shape to the EchoLeak attack vector. | **Low** (server-mints challenge, operator's reply echoes it, ~30 LoC) for HMAC-nonce. **High** for full macaroon/biscuit. | https://supertokens.com/blog/auth-for-ai-agents ; https://www.strata.io/blog/agentic-identity/why-agentic-ai-demands-more-from-oauth-6a/ ; https://fly.io/blog/operationalizing-macaroons/ |
| **Cross-channel approval for high-privilege commands** | OpenAI Agents SDK + Microsoft Agent Framework + n8n all explicitly route review through a *different channel* than the main interaction. For us this means: a destructive admin command issued in Slack channel C requires acknowledgement in a separate operator DM, or carries a one-time HMAC nonce delivered out-of-band. | **Medium.** Reuses the pairing-code state machine in `access.json`. | https://openai.github.io/openai-agents-js/guides/human-in-the-loop/ ; https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval |
| **Threshold-gated "thinking" indicator** | Gnewuch et al. (2022, BISE n=202) — typing indicators help novice users via social presence but are **neutral-to-irritating for experienced users**. NN/g: no indicator under 1s, lightweight at 1-9s, percent + cancel at 10s+. The PR shipped an always-on indicator; if shipped, it should be threshold-gated (drop at ~1.5s of silence, remove on first stream chunk). | **Low.** Timer plus a removal hook. But: secondary to streaming partial replies via `chat.update`, which beats any indicator outright. | https://link.springer.com/article/10.1007/s12599-022-00755-x ; https://www.nngroup.com/articles/response-times-3-important-limits/ |
| **Cross-bot manifest declaration for admin capabilities** | Bot-manifest protocol (`manifest.ts`) already enforces "advertisements are not grants." Extending the manifest to declare admin-capability availability lets peer bots discover the surface explicitly — closes a future ambiguity around `allowBotIds` interplay with admin commands. | **Medium.** One field in the manifest schema, validator update. Probably defer until a second principal is in flight. | https://github.com/openclaw/acpx — naming convention for forward-compat |

## Patterns explicitly ruled out

| Anti-pattern | Why it's contraindicated | Evidence |
|---|---|---|
| **Shell exec from a Slack message, even with allowlist** | EchoLeak's bypass chain (XPIA classifier → reference-style markdown → auto-fetched image → Teams-proxy CSP) is exactly the class of bypass that "send-keys + allowlist + secure shell-exec" cannot defend against — the attacker doesn't need to break the shell-exec, they need to coerce a privileged operator's session into emitting the magic string. "Your AI, My Shell" (Liu et al., 2025) reports **84% attack success** getting Cursor/Copilot to run malicious commands via poisoned external resources. | CVE-2025-32711 / arXiv 2509.10540 ; arXiv paperId `a75e8fbb6fa08ac1283619fd32f85057f561a003` |
| **Allowlist-only shell command filter** | OpenClaw security analysis (2026, paperId `84f8929813b8b87fe6ae6afe921812ae4bf604cb`) — allowlist's closed-world assumption is broken by shell line-continuation, busybox multiplexing, and GNU option abbreviation. Three Mod/High advisories compose into unauthenticated RCE. | arXiv 2026 |
| **The "DIE command" foot-gun** | Hubot's default install ships an ungated kill command; documented as a universal anti-pattern in bot frameworks. PR #157's `!restart` is structurally identical. | https://github.com/hubot-archive/hubot-auth ; https://www.bfcamara.com/post/89658506788/hubot-security-considerations/ |
| **Free-text admin command parsing in the bot process** | Production chatops (Rundeck, StackStorm) treats chat as transport, not auth domain — chat dispatches a *named, pre-defined* job. Free-text parsing in `server.ts` would make the bot the policy enforcer, which the literature universally argues against. | https://docs.rundeck.com/docs/learning/solutions/automated-diagnostics/integrating-chat-tools.html ; https://docs.stackstorm.com/chatops/chatops.html |

## Revised recommendation: Option 4

**Adopt a refined merger of Options 2 + 3 — admin commands as policy-evaluated typed events, no shell-exec ever from Slack, operator-owned tmux clear stays local to the operator's box.**

### What it looks like

1. **New event kinds in `journal.ts`:** `admin.clear`, `admin.restart`, `admin.quiesce` (alongside the existing `session.*` family). Each event body carries `{actor: session_owner, prior_chain_head_hash, command_nonce, reason}`. The chain-prevHash linkage is already there; nonce is the new field.

2. **New virtual tools in `policy.ts`:** `admin.clear` and `admin.restart` evaluated through `evaluate()` exactly like every other tool call. Default deny. Per-channel policy opts in. Shadowing detector already catches dangerous broad rules.

3. **Slack handler is a thin dispatcher:** matches `^!(clear|restart)\s*$` *after* `gate()` has approved the inbound message (mention-strip fix included), constructs the synthetic tool-call payload, hands to `policy.evaluate()`. No `execSync`, no `tmux send-keys`, no shell strings constructed from message text.

4. **`!clear` → `supervisor.quiesce(key)` → fresh `activate(key, …)`**. The on-disk session file is preserved; the in-memory handle is released and re-loaded. This is the **only** state mutation needed — there is no Claude-Code-CLI-side `/clear` to trigger because **Claude Code has no documented external IPC** (anthropics/claude-code#53049 was closed as duplicate; send-keys is the only primitive, and we are refusing to use it). The next inbound message re-activates from a clean memory state.

5. **`!restart` → `supervisor.shutdown()` → process exit, supervised restart**. Our existing graceful-shutdown path. The bridge re-pairs and re-activates on its own.

6. **Tmux clearing of the human operator's *local* Claude Code CLI is out of scope for the bridge entirely.** If Jeremy wants a one-key local clear, that lives in `~/bin/claude-clear` on his box, triggered by a local hotkey. The Slack bridge has zero shell-exec authority by design. This closes the EchoLeak-class attack surface for this feature outright.

7. **Optional: per-action HMAC nonce.** The bridge mints a short-lived (60s) nonce when an admin command is requested, posts it as a Slack ephemeral message back to the operator, and only accepts the follow-up `!clear <nonce>` reply. ~30 LoC, prevents replay and chat-history-poisoning attacks. Defer if the time cost is prohibitive — operator-id allowlist is the floor, nonce is the ceiling.

8. **No "💭 thinking" indicator in this PR.** If shipped at all, threshold-gate it per Nielsen — drop a reaction emoji at 1.5s of silence, remove on first chunk. But: investing the same effort into streaming partial replies via `chat.update` is empirically a stronger intervention (OpenAI / Anthropic / Redis practitioner consensus). File as a separate bd if Jeremy wants it; don't bundle.

### Why this is better than the three earlier options

- **vs Option 1 (merge PR #157 with Gemini hardening):** Option 1 still routes destructive operations through shell-exec + Slack-id allowlist — concrete CVE-9.3 attack class (EchoLeak), 84%-success academic attack class ("Your AI, My Shell"). Hardening the shell-exec doesn't fix the architectural mismatch. Reject.
- **vs Option 2 (refactor to supervisor.quiesce):** Option 2 is structurally inside Option 4 — quiesce is one of the typed events. Option 4 adds the policy evaluation + journal recording that make the operation *traceable and gated*, not just *correct*.
- **vs Option 3 (split slack-native reset + operator-owned tmux clear):** Option 3 is also inside Option 4 — the operator-owned tmux clear stays local-only, which is what Option 4 enforces. Option 4 strengthens the Slack-native half by routing it through the policy engine and journal instead of leaving it as a special-case handler.

### What it costs

- ~2 days of focused work: schema additions (`EventKind`, virtual tool entries in `policy.ts`), one new test file, one design-doc update to `000-docs/audit-journal-architecture.md` adding the `admin.*` family.
- Zero new runtime dependencies.
- No backwards-compatibility break — the current bot has no `!clear` / `!restart` shipped, so this is purely additive.

### What it doesn't try to do

- Does not interrupt the *Claude Code CLI process* itself mid-turn. Anthropic has not shipped that primitive (#53049 closed as duplicate). When they do, our `!clear` semantics map cleanly to `session/cancel` via ACP. This is forward-compat, not regression.
- Does not implement Merkle inclusion proofs or Ed25519 signing on the journal. That is the next-tier upgrade (Right to History, Zhang 2026; AEGIS, Yuan et al. 2026). File as a separate bd.
- Does not add capability-token formats (macaroon / biscuit / UCAN / DPoP). Operator allowlist + optional HMAC nonce is the pragmatic floor for now.

## Open follow-up questions (each merits its own bd)

1. **Ed25519 signing on top of hash chain.** AEGIS and Right to History both adopt it. Cost: keypair management, but the gain is non-repudiable verification by a third party. File as: "Upgrade `journal.ts` to Ed25519-signed Merkle checkpoints."
2. **ACP wire-protocol adoption.** acpx (openclaw/acpx) is the reference implementation. If Anthropic ever opens an external-message-injection API, ACP is the standardized envelope. File as: "Adopt Agent Client Protocol semantics for admin commands."
3. **Streaming partial replies via `chat.update`.** Empirically a stronger latency intervention than any indicator. File as: "Stream Claude Code output to Slack incrementally."
4. **Capability-token format (macaroon / biscuit) for multi-operator delegation.** Premature until a second principal is in flight, but worth a tracking bd. File as: "Evaluate capability-token formats for delegated operator control."
5. **Documenting the EchoLeak / Slack-MCP-unfurl threat class in `THREAT-MODEL.md`.** Both are 2025 production CVEs in our exact problem class. Should be cited explicitly so future PRs adding admin surfaces inherit the constraint.

## Sources

### Lane A — Academic literature

- Singh & Madisetti, **MCP-Secure: A Runtime Access Control Layer for Privilege-Aware LLM Agent Tooling**, IEEE Open J. CS, 2026. paperId `dae70c05578f62eab9618d07aa6f5ed6bfd0e9a4`
- Yuan, Su, Zhao, **AEGIS: No Tool Call Left Unchecked — A Pre-Execution Firewall and Audit Layer for AI Agents**, arXiv 2026. paperId `c67408b6affa8d47e7bd1cf82798eea8a59fde4c`
- Liu et al., **"Your AI, My Shell": Demystifying Prompt Injection Attacks on Agentic AI Coding Editors**, arXiv 2025. paperId `a75e8fbb6fa08ac1283619fd32f85057f561a003`
- Suwansathit et al., **A Security Analysis of the OpenClaw AI Agent Framework**, arXiv 2026. paperId `84f8929813b8b87fe6ae6afe921812ae4bf604cb`
- Zhang, **Right to History: A Sovereignty Kernel for Verifiable AI Agent Execution**, arXiv 2026. paperId `dc9fb3c506e5242512fe076fa89a49a48d5652ae`
- Kim, Shams, Kim, **From Seconds to Sentiments: Differential Effects of Chatbot Response Latency on Customer Evaluations**, Int'l J. Human-Computer Interaction, 2025. paperId `398dea0a66038308b85102d9faf4a3031eb24144`
- Wang et al., **Sema Code: Decoupling AI Coding Agents into Programmable, Embeddable Infrastructure**, arXiv 2026. paperId `6c044483af81c8bebb4d9d05250e511b18a3e950`
- Khan et al., **AGENTSAFE: A Unified Framework for Ethical Assurance and Governance in Agentic AI**, arXiv 2025. paperId `4b01e270084fd189a04ef31e8dda65e0bc927e42`
- Staufer et al., **The 2025 AI Agent Index**, arXiv 2026. corpusId `285872007`
- Qin et al., **EmbodiedGovBench: A Benchmark for Governance, Recovery, and Upgrade Safety in Embodied Agent Systems**, arXiv 2026. paperId `3afb8112e94949ed3b34f5f830f01870d9f53643`
- Chang & Xu, **Design and Implementation of a Zero Trust Access Control Model Driven by Session Lifecycle**, IEEE Access 2026. paperId `976c1f2d5ef8ecdd7f70faf255b567ddcd9888b4`

### Lane B — Open-source ecosystem

- [Claude Code headless mode docs](https://code.claude.com/docs/en/headless)
- [anthropics/claude-code#53049 — External message injection API (closed as dup)](https://github.com/anthropics/claude-code/issues/53049)
- [Agent Client Protocol — Prompt Turn (session/cancel)](https://agentclientprotocol.com/protocol/prompt-turn)
- [openclaw/acpx — Headless ACP CLI](https://github.com/openclaw/acpx)
- [OpenHands EventStream — SDK arch/events](https://docs.openhands.dev/sdk/arch/events)
- [Aider scripting docs](https://aider.chat/docs/scripting.html)
- [Hubot-auth README](https://github.com/hubot-archive/hubot-auth) + [Hubot security considerations — bfcamara](https://www.bfcamara.com/post/89658506788/hubot-security-considerations/)
- [Errbot Administration docs](https://errbot.readthedocs.io/en/latest/user_guide/administration.html)
- [peter-evans/slash-command-dispatch](https://github.com/peter-evans/slash-command-dispatch)
- [Rundeck ChatOps integration](https://docs.rundeck.com/docs/learning/solutions/automated-diagnostics/integrating-chat-tools.html)
- [StackStorm ChatOps](https://docs.stackstorm.com/chatops/chatops.html)
- [Supervisor XML-RPC API](https://supervisord.org/api.html)
- [Zellij IPC architecture — poor.dev](https://poor.dev/blog/building-zellij-web-terminal/)
- [google/adk-python#2425 — cancel API request](https://github.com/google/adk-python/issues/2425)
- [zed-industries/zed#50592 — stop/interrupt missing](https://github.com/zed-industries/zed/issues/50592)

### Lane C — Security, audit, UX

- [EchoLeak / CVE-2025-32711 — arXiv 2509.10540](https://arxiv.org/abs/2509.10540) + [HackTheBox writeup](https://www.hackthebox.com/blog/cve-2025-32711-echoleak-copilot-vulnerability) + [Varonis](https://www.varonis.com/blog/echoleak)
- [PromptArmor — Slack AI exfiltration](https://www.promptarmor.com/resources/data-exfiltration-from-slack-ai-via-indirect-prompt-injection) + [MITRE ATLAS AML-CS0035](https://www.startupdefense.io/mitre-atlas-case-studies/aml-cs0035-data-exfiltration-from-slack-ai-via-indirect-prompt-injection)
- [Embrace The Red — Anthropic Slack MCP unfurl vulnerability](https://embracethered.com/blog/posts/2025/security-advisory-anthropic-slack-mcp-server-data-leakage/)
- [Socket.dev — Linux Foundation Slack impersonation](https://socket.dev/blog/attackers-impersonating-linux-foundation-leaders-in-slack-targeting-oss-developers) + [Push Security — Phishing Slack for persistence](https://pushsecurity.com/blog/phishing-slack-persistence)
- [Log-To-Leak — OpenReview 2025](https://openreview.net/forum?id=UVgbFuXPaO)
- [SuperTokens — Secure AI agents with scoped tokens](https://supertokens.com/blog/auth-for-ai-agents) + [Strata — 2026 OAuth Agentic AI guide](https://www.strata.io/blog/agentic-identity/why-agentic-ai-demands-more-from-oauth-6a/)
- [Fly.io — Operationalizing Macaroons](https://fly.io/blog/operationalizing-macaroons/) + [Macaroons Escalated Quickly](https://fly.io/blog/macaroons-escalated-quickly/)
- [UCAN spec](https://github.com/ucan-wg/spec)
- [AuditableLLM — MDPI Electronics 15/1](https://www.mdpi.com/2079-9292/15/1/56)
- [RFC 6962 Certificate Transparency](https://datatracker.ietf.org/doc/html/rfc6962) + [How CT Works](https://certificate.transparency.dev/howctworks/)
- [Gnewuch et al. 2022 — BISE Opposing Effects of Response Time](https://link.springer.com/article/10.1007/s12599-022-00755-x)
- [NN/g — Response Time Limits](https://www.nngroup.com/articles/response-times-3-important-limits/) + [Progress Indicators](https://www.nngroup.com/articles/progress-indicators/)
- [OpenAI Agents SDK — HITL](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/) + [Microsoft Agent Framework tool approval](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval)
- [MindStudio — production guardrails](https://www.mindstudio.ai/blog/deploy-ai-agents-production-budget-guardrails-monitoring) + [Dextra Labs — Agentic AI Safety Playbook 2025](https://dextralabs.com/blog/agentic-ai-safety-playbook-guardrails-permissions-auditability/)
- [Anthropic — Equipping Agents with Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)

### Citations flagged as unverified

- AIP arXiv ID `2603.24775` (Agent Identity Protocol) — ID format suspect; treated as informational only above.
- Harrison/Yeo/Hudson 2010 progress-bar "3× wait tolerance" figure — practitioner-attributed but not verified against the primary CHI paper in this pass.
