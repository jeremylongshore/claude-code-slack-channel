
---

# PART 2 — X / TWITTER (long-form post)

Copy everything inside the box:

```
Anthropic just shipped the best agentic teammate you can rent.

Claude Tag drops @Claude into a Slack channel — autonomous tool calls, compounding memory, an isolated sandbox, an Agent Proxy that keeps raw keys away from the model. Zero infrastructure. It's genuinely good engineering, and if you want an agent in Slack tomorrow, use it.

Here's the honest trade you're making: the substrate is theirs. The sandbox, the memory, and the audit log all live on Anthropic's infra and under their control. Governance is coarse — channel scope + spend caps, not a human approval before each consequential action. And the audit is a log you're shown, not one you can verify.

AlphaSignal said it best: rent the agent, own the memory. Claude Tag inverts that — you rent the agent and the memory becomes the vendor's proprietary state.

So we built the other side, open source (Apache-2.0):
• CCSC — a deterministic per-tool-call policy engine + human-in-command approval + a signed, offline-verifiable audit you check with your OWN public key. No vendor in the trust path.
• AGP — reimplements & hardens that kernel with a sandbox that proves egress is off, and a signed-HEAD checkpoint that catches a truncated log a plain hash chain can't.

Both approaches are legitimate. Pick by who has to own the substrate — and who has to be able to prove what the agent did.

Deep-dive: [PASTE SUBSTACK ARTICLE URL]
Code: github.com/jeremylongshore/claude-code-slack-channel · github.com/jeremylongshore/agent-governance-plane
```

---

# PART 3 — LINKEDIN (Jeremy's personal profile)

```
Anthropic just made every business ask a question most aren't ready for.

Claude Tag went live last week — tag @Claude in a Slack channel and it works like a teammate: runs tools, files tickets, remembers your channel, acts autonomously. Zero setup. I'll say plainly: it's excellent. The sandbox is strong, and credentials are kept away from the model (with egress reportedly defaulting to deny). If you want an agent in Slack tomorrow with no infrastructure, this is the product.

But there's a trade underneath the convenience, and it's worth naming out loud: the substrate is Anthropic's. The sandbox, the memory your agent builds, and the log of everything it did all live on their infrastructure, under their control. Governance is coarse — you choose which channels and tools, and you set a spend cap. What you don't get is a human approval before each consequential action, or an audit trail you can verify yourself.

That's not a knock on Anthropic — the incentives are just obvious. AlphaSignal framed the principle well: rent the agent, own the memory. Claude Tag inverts it.

I spent 20 years running restaurant and trucking operations before I wrote software. In both, you learn the same lesson: when something goes wrong, "trust me" is not an answer — you need a record you can prove. So I built the other side, open source:

→ CCSC: a deterministic policy engine that approves or denies each tool call, with a human in the loop for the ones that matter, and a signed audit log you verify with your own key.
→ AGP: the same guarantees, plus a sandbox that proves it's isolated and catches a log that's been quietly truncated.

Both approaches are legitimate. If you want zero ops, rent. If you need the agent, its memory, and its audit trail to be yours and verifiable on your own infra, own it.

The question was never which agent is smarter. It's who has to own the substrate — and who has to be able to prove what happened.

Deep-dive + code in the comments. #AIagents #AIgovernance #Slack #OpenSource
```

**First comment to post under it** (so the links don't suppress reach):

```
Deep-dive: [PASTE SUBSTACK ARTICLE URL]
CCSC: https://github.com/jeremylongshore/claude-code-slack-channel
AGP: https://github.com/jeremylongshore/agent-governance-plane
```

---

# PART 4 — LINKEDIN (Intent Solutions company page)

```
Anthropic shipped Claude Tag. Here's the question it leaves on the table.

Last week Anthropic launched Claude Tag — an agentic @Claude teammate inside Slack, replacing the legacy Claude in Slack app (retiring August 3). It's a strong product: zero-setup, multiplayer shared memory, an isolated sandbox, and an Agent Proxy that keeps credentials away from the model (deny-by-default egress, per its launch coverage). For teams that want an autonomous agent with no infrastructure, it's an excellent choice.

The trade it asks you to accept: the substrate is the vendor's. The sandbox, the org memory the agent builds, and the audit log of what it did all run on Anthropic's infrastructure. Governance is coarse-grained — channel scope and spend caps — and the audit is a record you can view, not one you can independently verify.

Intent Solutions builds the customer-owned alternative, open source under Apache-2.0:
• CCSC — a governance kernel: a deterministic per-tool-call policy engine, human-in-command approval for consequential actions, and a signed, offline-verifiable audit log you check with your own public key. No vendor in the trust path.
• AGP — reimplements and hardens that kernel with a self-hosted sandbox that proves its network isolation, and a signed-HEAD checkpoint that detects a truncated log a plain hash chain cannot.

This isn't a security critique of Claude Tag — its sandbox and credential handling are genuinely strong. It's an ownership and verifiability position: for regulated, security-conscious, or sovereignty-sensitive teams, the agent, its memory, and its audit trail should be yours, on your infrastructure, provable with your own key.

Both models are legitimate. The right one depends on who must own the substrate — and who must be able to prove what happened.

Read the technical deep-dive: [PASTE SUBSTACK ARTICLE URL]
CCSC: https://github.com/jeremylongshore/claude-code-slack-channel
AGP: https://github.com/jeremylongshore/agent-governance-plane

#AIagents #AIgovernance #EnterpriseAI #Slack #OpenSource
```

---

*Any questions on the framing, ping Jeremy. — sent via Intent Solutions*
