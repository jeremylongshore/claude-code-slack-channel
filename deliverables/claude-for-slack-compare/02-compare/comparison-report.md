# Claude for Slack, four ways: rent vs. own the governance substrate

*Compare/contrast — Anthropic's two official Slack products vs. two open-source governance stacks. Draft, 2026-06-30. Every cell traces to a primary source (Anthropic announcement, repo code, or a cited paper); honest-offset framing — no FUD.*

There are now **four** ways to put Claude to work in Slack, and they split cleanly along one axis: **who owns the substrate the agent runs on** — the sandbox, the memory, and the audit log.

- **Anthropic "Claude in Slack" (legacy)** — the chat/summarize connector, **retiring August 3, 2026**.
- **Anthropic "Claude Tag" / @Claude** — the new agentic teammate (launched June 23, 2026). The best agent you can *rent*.
- **CCSC** ([claude-code-slack-channel](https://github.com/jeremylongshore/claude-code-slack-channel)) — an open-source governance *kernel*: deterministic policy, per-tool-call human approval, signed offline-verifiable audit. Apache-2.0, self-hosted.
- **AGP** ([agent-governance-plane](https://github.com/jeremylongshore/agent-governance-plane)) — reimplements-and-hardens that kernel with sandboxed, multi-harness execution. Apache-2.0, self-hosted.

## The matrix

| Dimension | **A — Claude in Slack** (legacy) | **B — Claude Tag / @Claude** | **CCSC** | **AGP** |
|---|---|---|---|---|
| **Hosting** | Anthropic (SaaS) | Anthropic infra (hosted sandbox) | **Self-host** (your infra) | **Self-host** (your infra) |
| **Agentic level** | Non-agentic (chat / summarize / Q&A) | Fully agentic teammate — autonomous tool calls, PRs, tickets, ambient + scheduled | Agentic (Claude Code in Slack), **gated per call** | Agentic execution, **gated + sandboxed** |
| **Approval model** | N/A (request/response) | **Coarse** — channel scope + admin-defined tools + token-spend caps; no documented per-action approval before execution | **Per-tool-call HITL** — `allow/deny/require`; `require` = human-in-command via reply-code approval, quorum by distinct user_id (peer-bot messages dropped at the gate) | **Per-tool-call HITL** — default-deny engine; Block-Kit Allow/Deny, nonce bound to (message, session); a bot can't approve |
| **Audit** | Vendor SaaS logs | **Vendor log** admins can *view* ("everything @Claude has done + who requested") | **Signed, offline-verifiable** — hash-chain + Ed25519 over RFC 8785 JCS + policy attestation; verify w/ public key only | **Signed + signed-HEAD checkpoint** — closes the truncation gap a bare chain can't; `agp verify` offline |
| **Data & memory ownership** | Vendor | **Vendor** — memory is Anthropic's proprietary state, channel-scoped, on their infra | **Yours** — state in `~/.claude/channels/slack/` on your infra | **Yours** — session store + journal on your infra |
| **Cost control** | Subscription (per plan) | **Token-spend caps** per org + per channel; billed to org | You own the model bill; deny expensive tools via policy. *Deterministic per-channel spend cap is on the roadmap — not yet shipped.* | You own the model bill; gate/deny via policy. *No built-in token-budget meter — control is by policy, not a cap.* |
| **Sandbox / isolation** | N/A | **Strong, managed** — isolated sandbox on Anthropic infra + Agent Proxy (*per launch coverage:* credentials injected at the network boundary, deny-by-default egress) | None itself — it's the governance kernel; sandboxed execution is delegated to AGP (by design) | **Hardened container** — `--network none`, `--cap-drop ALL`, `no-new-privileges`, pid/mem limits; network **preflight proves egress off** (fails closed); image pinning; secret deny-list. *Namespace/cgroup, not VM-grade.* |
| **Credential handling** | Vendor-managed | Agent Proxy — model never sees raw keys (*per launch coverage*) | Value-firewall — secret **values** never sent; token-shape redaction in journal | "Gate, don't impersonate" — holds no model creds; `{{secret:NAME}}` resolved post-gate at exec; journals secret **names** only |
| **Harnesses / model** | Claude | Claude (Opus 4.8) | Claude Code (MCP stdio) | **Multi-harness by contract** — Claude Code + Codex via one gate. *Live Codex interception is provisional, not CI-validated.* |
| **License** | Proprietary | Proprietary | **Apache-2.0 (open source)** | **Apache-2.0 (open source)** |
| **Setup cost** | Low (connector) | **Lowest** — zero infra, tag & go | Higher — you run + operate it | Higher — you run + operate it |
| **Target user** | Anyone wanting Q&A/summaries (sunsetting) | Enterprise/Team wanting a zero-setup autonomous teammate on managed infra | Regulated / security-conscious teams needing verifiable audit + per-call HITL on their own infra | Same, plus sandboxed multi-harness execution |

## Pros & cons, per product (honest)

### A — Claude in Slack (legacy) · *retiring Aug 3, 2026*
- **Pros:** Dead-simple; good at summarize/answer; near-zero setup.
- **Cons:** Not agentic; being retired — migration is effectively forced.

### B — Claude Tag / @Claude · *the best agent you can rent*
- **Pros:** Zero infrastructure; multiplayer shared memory that compounds automatically; ambient + scheduled autonomous work; **genuinely strong managed security** (isolated sandbox + Agent Proxy; credential-injection / deny-by-default egress per launch coverage); token-spend caps; central admin governance out of the box.
- **Cons:** The substrate is Anthropic's — sandbox, **memory, and audit log all live on their infra and under their control**. Governance is coarse (channel scope + spend caps, not per-action approval). The audit is a record you're *shown*, not one you can *verify* with your own key. Context lock-in: the memory is not an exportable dataset your next vendor can ingest.

### CCSC · *the governance kernel*
- **Pros:** Deterministic per-tool-call policy (`allow/deny/require`; `upload_file` fail-closed by default, and fail-closed on anything else you author a rule for); human-in-command approval via reply-code + quorum (peer-bot messages dropped at the inbound gate); **signed, offline-verifiable audit** (hash-chain + Ed25519 + policy attestation) you check with only a public key; five prompt-injection defense layers; small, auditable scope; Apache-2.0; **you own the memory + audit on your infra.**
- **Cons:** You host and operate it; no execution sandbox of its own (that's AGP's job); no shipped per-channel spend cap yet; a bare hash-chain alone does **not** stop log truncation (documented as threat T8 — AGP fixes it); doesn't protect a compromised host OS / same-UID process (documented, by design).

### AGP · *sandboxed, multi-harness, hardened*
- **Pros:** Everything CCSC's governance guarantees, plus a **hardened sandbox that proves egress is off** (network preflight, fails closed, no silent host fallback); **signed-HEAD checkpoint closes the truncation gap**; "gate, don't impersonate" credential model; one governance gate across Claude Code + Codex; Apache-2.0; self-host.
- **Cons:** You host and operate it; sandbox is namespace/cgroup, **not VM-grade** (a kernel/container escape defeats it — documented); live Codex interception is provisional / not CI-validated; self-assessed test grade B− (78/100); not multi-tenant (fails closed).

## What *only* Claude Tag does (give it its due)
1. **Zero infrastructure / zero-ops** — tag and go.
2. **Multiplayer memory that compounds automatically** across a channel (and across channels with permission).
3. **Ambient/proactive + scheduled autonomous work** with no orchestration to build.
4. **Fully-managed strong sandbox + Agent Proxy** — no security engineering required of you.
5. **Built-in token-spend caps** and central org governance on day one.

## What *only* CCSC + AGP do (the wedge)
1. **A signed, offline-verifiable audit** you check with **your own public key** — no vendor in the trust path.
2. **AGP's signed-HEAD checkpoint** catches a *truncated* log (a dropped tail) — the exact gap CCSC documents as T8 and a plain chain can't detect.
3. **Deterministic, fine-grained per-tool-call policy** — default-deny in AGP; deterministic and fail-closed where you author it (plus `upload_file` by default) in CCSC — authority per action, not channel scope + budget.
4. **Human-in-command approval per consequential call**, with anti-self-approval a peer bot can't satisfy (CCSC drops bot messages at the gate; AGP's approval nonce can't be burned by a bot's click).
5. **The memory and the audit are yours**, on your infrastructure — portable, no context lock-in.
6. **A sandbox that *proves* egress is off** (preflight fails closed), not one you take on trust.
7. **One governance gate across multiple harnesses** (Claude Code + Codex).

## The one-line takeaway
> **Claude Tag is the best agent you can rent.** If your governance model needs the agent — and its memory and its audit trail — to be **yours** and **verifiable on your own infra**, you host it (CCSC for the kernel, AGP for sandboxed multi-harness execution). Both are legitimate. Pick by **who must own the substrate.**

## Sources
- Anthropic, *Introducing Claude Tag* — https://www.anthropic.com/news/introducing-claude-tag
- Legacy retirement date (Aug 3, 2026) — https://www.techtimes.com/articles/319206/20260627/claude-tag-brings-ambient-ai-slack-admins-have-until-august-3-migrate.htm
- AlphaSignal, *The Real Claude Tag Question Is Context Ownership* (the context-ownership framing; "rent the agent, own the memory") — https://alphasignalai.substack.com/p/the-real-claude-tag-question-is-context
- Context lock-in — https://ksingh7.medium.com/everyones-worried-about-model-lock-in-but-the-real-trap-is-context-lock-in-af04c16167b0
- CCSC — https://github.com/jeremylongshore/claude-code-slack-channel · AGP — https://github.com/jeremylongshore/agent-governance-plane
- Prompt-injection evidence: InjecAgent (arXiv:2403.02691); Adaptive Attacks Break Defenses (arXiv:2503.00061); MCP Security Bench (arXiv:2510.15994). Full list in `_research/citations.md`.
