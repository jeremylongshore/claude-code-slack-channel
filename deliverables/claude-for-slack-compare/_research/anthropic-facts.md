# Anthropic's two Slack products — verified facts + honest offsets + criticism

> Source of truth for every NON-repo claim in the content set. Repo/technical claims live in the plan's Phase 0 and `citations.md`.
> **Posture (Jeremy, 2026-06-30):** *"be honest about what running Claude Tag provides as an offset — but with vendor lock-in in mind."* No FUD, no hit piece. Acknowledge the genuine engineering; hold ownership/verifiability as the lens. Claude Tag's security model is **good**; the wedge is **who owns the substrate**, not "theirs is insecure."

---

## Product A — legacy "Claude in Slack" (chat/summarize app + connector)
- Being **retired August 3, 2026**. Admins have a **30-day window** from the Claude Tag launch (Jun 23, 2026) to opt in / migrate. — [Anthropic announcement](https://www.anthropic.com/news/introducing-claude-tag); [TechTimes](https://www.techtimes.com/articles/319206/20260627/claude-tag-brings-ambient-ai-slack-admins-have-until-august-3-migrate.htm)
- Was a request/response assistant + connector (summarize threads, answer questions). Not agentic; no autonomous tool execution.

## Product B — Claude Tag / @Claude (the agentic teammate)
**Launch:** June 23, 2026, "available today in beta for Claude Enterprise and Team customers." Runs on **Opus 4.8**. — [Anthropic](https://www.anthropic.com/news/introducing-claude-tag)

### Genuine benefits (the honest "offset" — state these plainly)
Verified against the official announcement + launch coverage:
- **Zero-infrastructure / zero-setup.** Tag `@Claude` in a channel — no servers to run, no deploy, no on-call. This is a real, large advantage over any self-hosted stack. — [Anthropic](https://www.anthropic.com/news/introducing-claude-tag)
- **Multiplayer shared context.** "one Claude that interacts with everyone" in a channel; "anyone can see what it's working on" and pick up where the last person left off. — [Anthropic](https://www.anthropic.com/news/introducing-claude-tag); [latent.space AINews](https://www.latent.space/p/ainews-claude-tag-multiplayer-proactive)
- **Persistent, compounding memory.** "@Claude learns over time… builds more context about the work" and "can even automatically learn from other Slack channels" (with permission). Memory "will stay scoped to the channels defined." — [Anthropic](https://www.anthropic.com/news/introducing-claude-tag)
- **Ambient / proactive mode.** With ambient enabled, Claude "will proactively keep you updated." Asynchronous: "Set Claude a task, and you can focus on your other priorities while it works." — [Anthropic](https://www.anthropic.com/news/introducing-claude-tag)
- **Org-identity + centralized admin governance.** Works under the org's identity; admins "specify which tools and information the model should have access to, in which channels." Billed to the org, not individuals. — [Anthropic](https://www.anthropic.com/news/introducing-claude-tag)
- **Identity isolation between uses.** "separate Claude identities for different uses" — e.g., sales data kept from engineering; no cross-channel data sharing by default. — [Anthropic](https://www.anthropic.com/news/introducing-claude-tag)
- **Token spend caps.** Admins "can set limits for token spend (both for the organization and for individual channels)." A real cost-control primitive. — [Anthropic](https://www.anthropic.com/news/introducing-claude-tag)
- **Vendor audit log.** Admins "can view a log of everything that @Claude has done, along with who requested each task." — [Anthropic](https://www.anthropic.com/news/introducing-claude-tag)

### Security architecture (genuinely strong — acknowledge it)
- **Isolated sandbox on Anthropic infrastructure**, per-use. Work runs sandboxed and hosted by Anthropic. — [Anthropic](https://www.anthropic.com/news/introducing-claude-tag); [buildfastwithai review](https://www.buildfastwithai.com/blogs/anthropic-claude-tag-slack-review)
- **Agent Proxy + credential injection at the network boundary.** Per launch coverage: requests to external systems "cross an Agent Proxy where credentials stay in a store and are injected at the network boundary without the model receiving raw keys," with a **default policy of deny** (hosts blocked unless explicitly allowed). — reported by [buildfastwithai](https://www.buildfastwithai.com/blogs/anthropic-claude-tag-slack-review), [digitalapplied](https://www.digitalapplied.com/blog/anthropic-claude-tag-slack-team-collaboration-2026). **⚠ FACT-CHECK BEFORE PUBLISH:** the Agent-Proxy specifics (credential injection, deny-by-default) appear in secondary coverage; the official *announcement* page I fetched did not spell them out. Re-verify against `claude.com/docs/claude-tag` before any artifact goes live; if unconfirmed, soften to "as reported in launch coverage."
  - **This posture is architecturally close to AGP's "gate, don't impersonate" + `{{secret:NAME}}` post-gate resolution + deny-by-default egress.** Say so — it's honest and it *strengthens* our position (we're not claiming a security gap; we're claiming an ownership gap).

### The honest limits (the lens — vendor lock-in / ownership, not "insecure")
1. **Runs on Anthropic infrastructure.** Sandbox, memory, and audit log all live on the vendor's infra. You do not host it and cannot air-gap or self-host it.
2. **Memory is the vendor's proprietary state.** "The organizational knowledge Claude builds while inhabiting a channel is Anthropic's proprietary state — not an exportable dataset your next vendor can ingest." — [AlphaSignal, "The Real Claude Tag Question Is Context Ownership"](https://alphasignalai.substack.com/p/the-real-claude-tag-question-is-context)
3. **Governance is coarse-grained.** Admin control = **which channels** + **which tools/data** + **token spend caps**. That is per-channel scope + budget, **not** documented per-tool-call human approval before each consequential action executes. (No public evidence of a mandatory human-in-command approval step per action.)
4. **The audit log is vendor-controlled.** Admins can *view* Anthropic's log; it is not a customer-signed, offline-verifiable record you can verify with your own key, independent of the vendor.

### The criticism (respectful, real — quote accurately)
- **AlphaSignal's principle** = **"rent the agent, own the memory"** — i.e., you *should* own the memory; the concern is "whether the full working context stays readable, exportable, and usable outside Claude Tag when the organization wants another agent, another model, or another vendor." — [AlphaSignal](https://alphasignalai.substack.com/p/the-real-claude-tag-question-is-context)
- **Context lock-in > model lock-in.** "Everyone's worried about model lock-in, but the real trap is context lock-in." — [Karan Singh, Medium](https://ksingh7.medium.com/everyones-worried-about-model-lock-in-but-the-real-trap-is-context-lock-in-af04c16167b0)
- **The Trojan-horse framing (note the fairness).** "Claude Tag is a Trojan horse. Not because Anthropic is doing anything evil. Because the incentives are obvious." — [Ashwin Gopinath on X](https://x.com/ashwingop/status/2069814177624121469). ← This is the exact tone to match: not accusing Anthropic of bad faith; naming the structural incentive.
- Enterprise-migration urgency ("30 days"): [Beri.net](https://www.beri.net/article/anthropic-claude-tag-slack-enterprise-agent-it-guide-2026), [TeamCopilot benefits+downsides](https://teamcopilot.ai/blog/claude-in-slack-explained-what-claude-tag-can-do-benefits-and-downsides).

---

## The wedge, stated honestly (spine of all artifacts)
Claude Tag is the **best zero-setup agentic teammate you can rent** — strong sandbox, credential hygiene, deny-by-default egress, central admin governance, compounding memory. If you want an agent in Slack tomorrow with no infra, it is an excellent product and we should say so.

The tradeoff you accept in exchange: **the substrate is Anthropic's.** The sandbox, the memory, and the audit log live on their infrastructure and under their control. Governance is *coarse* (channel scope + spend caps), and the record is *theirs to show you*, not *yours to verify*.

CCSC + AGP make the opposite trade: **you run it, you own the memory, and the audit is a signed, offline-verifiable record you check with your own public key — no vendor in the trust path.** Governance is *fine-grained* (deterministic per-tool-call policy) and approval is *per-action* (human-in-command HITL). The cost you accept in exchange: **you host it, and you build the memory/UX Anthropic gives you for free.** That is the honest two-way trade — name both sides.

> One-liner (honest, non-FUD): *"Claude Tag is the best agent you can rent. If your governance model needs the agent — and its memory and its audit trail — to be **yours** and **verifiable on your own infra**, you host it. Both are legitimate; pick by who must own the substrate."*
