# Social drafts — "rent the agent, own the proof" (#1)

**DRAFT — for manual posting after Jeremy reviews.** Honest-offset framing (Claude Tag is genuinely strong; the wedge is ownership + verifiability, not "insecure"). No FUD, no banned terms. Replace `[LINK: startaitools deep-dive]` with the live URL once the #3 post is published; repos link directly.

---

## 1) Long-form X / Twitter (single post)

> Anthropic just shipped the best agentic teammate you can *rent*.
>
> Claude Tag drops @Claude into a Slack channel — autonomous tool calls, compounding memory, an isolated sandbox, an Agent Proxy that keeps raw keys away from the model. Zero infrastructure. It's genuinely good engineering, and if you want an agent in Slack tomorrow, use it.
>
> Here's the honest trade you're making: the substrate is theirs. The sandbox, the memory, and the audit log all live on Anthropic's infra and under their control. Governance is coarse — channel scope + spend caps, not a human approval before each consequential action. And the audit is a log you're *shown*, not one you can *verify*.
>
> AlphaSignal said it best: rent the agent, own the memory. Claude Tag inverts that — you rent the agent and the memory becomes the vendor's proprietary state.
>
> So we built the other side, open source (Apache-2.0):
> • CCSC — a deterministic per-tool-call policy engine + human-in-command approval + a signed, offline-verifiable audit you check with your OWN public key. No vendor in the trust path.
> • AGP — reimplements & hardens that kernel with a sandbox that *proves* egress is off, and a signed-HEAD checkpoint that catches a truncated log a plain hash chain can't.
>
> Both approaches are legitimate. Pick by who has to own the substrate — and who has to be able to prove what the agent did.
>
> Deep-dive: [LINK: startaitools deep-dive]
> Code: github.com/jeremylongshore/claude-code-slack-channel · github.com/jeremylongshore/agent-governance-plane

### Optional short thread (if you'd rather thread it)
```
1/ Anthropic shipped the best agentic teammate you can *rent*. Claude Tag: @Claude in a Slack channel, autonomous tool calls, compounding memory, a strong managed sandbox, zero infra. It's good. Use it if you want an agent tomorrow with no ops.

2/ The honest trade: the substrate is theirs. Sandbox, memory, AND the audit log run on Anthropic's infra, under their control. Governance is coarse — channel scope + spend caps, not human approval before each action.

3/ And the audit log is one you're *shown*, not one you can *verify*. For most teams, fine. For a regulated shop or a security vendor, "trust our log" isn't the same as "here's a record, check it yourself."

4/ AlphaSignal's principle: rent the agent, own the memory. Claude Tag inverts it — the org memory becomes the vendor's proprietary state, not an exportable asset your next vendor can ingest. That's context lock-in.

5/ So we shipped the other side, open source (Apache-2.0):
CCSC — deterministic per-tool-call policy + human-in-command approval + a signed audit you verify offline with your own public key.

6/ AGP hardens it: a sandbox that *proves* egress is off (preflight fails closed), and a signed-HEAD checkpoint that catches a truncated log a bare chain can't detect.

7/ Not "theirs is insecure" — their sandbox + credential proxy are strong. It's an ownership question: rent the capability, or own a verifiable substrate on your own infra.

8/ Both are legitimate engineering positions. Pick by who must own the substrate — and who must be able to prove what happened.
Deep-dive: [LINK] · Code: github.com/jeremylongshore/claude-code-slack-channel + /agent-governance-plane
```

---

## 2) LinkedIn — personal (Jeremy's voice)

> Anthropic just made every business ask a question most aren't ready for.
>
> Claude Tag went live last week — tag @Claude in a Slack channel and it works like a teammate: runs tools, files tickets, remembers your channel, acts autonomously. Zero setup. I'll say plainly: it's excellent. The sandbox is strong, and credentials are kept away from the model (with egress reportedly defaulting to deny). If you want an agent in Slack tomorrow with no infrastructure, this is the product.
>
> But there's a trade underneath the convenience, and it's worth naming out loud: **the substrate is Anthropic's.** The sandbox, the memory your agent builds, and the log of everything it did all live on their infrastructure, under their control. Governance is coarse — you choose which channels and tools, and you set a spend cap. What you don't get is a human approval before each consequential action, or an audit trail you can verify yourself.
>
> That's not a knock on Anthropic — the incentives are just obvious. As one commenter put it fairly, it's not that Anthropic is doing anything wrong; the incentives just are what they are. AlphaSignal framed the principle well: rent the agent, own the memory. Claude Tag inverts it.
>
> I spent 20 years running restaurant and trucking operations before I wrote software. In both, you learn the same lesson: when something goes wrong, "trust me" is not an answer — you need a record you can prove. So I built the other side, open source:
>
> → CCSC: a deterministic policy engine that approves or denies each tool call, with a human in the loop for the ones that matter, and a signed audit log you verify with your own key.
> → AGP: the same guarantees, plus a sandbox that *proves* it's isolated and catches a log that's been quietly truncated.
>
> Both approaches are legitimate. If you want zero ops, rent. If you need the agent, its memory, and its audit trail to be yours and verifiable on your own infra, own it.
>
> The question was never which agent is smarter. It's who has to own the substrate — and who has to be able to prove what happened.
>
> Deep-dive + code in the comments. #AIagents #AIgovernance #Slack #OpenSource

*(First comment to add after posting: `Deep-dive: [LINK: startaitools deep-dive] · CCSC: https://github.com/jeremylongshore/claude-code-slack-channel · AGP: https://github.com/jeremylongshore/agent-governance-plane`)*

---

## 3) LinkedIn — company (Intent Solutions)

> **Anthropic shipped Claude Tag. Here's the question it leaves on the table.**
>
> Last week Anthropic launched Claude Tag — an agentic @Claude teammate inside Slack, replacing the legacy Claude in Slack app (retiring August 3). It's a strong product: zero-setup, multiplayer shared memory, an isolated sandbox, and an Agent Proxy that keeps credentials away from the model (deny-by-default egress, per its launch coverage). For teams that want an autonomous agent with no infrastructure, it's an excellent choice.
>
> The trade it asks you to accept: the substrate is the vendor's. The sandbox, the org memory the agent builds, and the audit log of what it did all run on Anthropic's infrastructure. Governance is coarse-grained — channel scope and spend caps — and the audit is a record you can view, not one you can independently verify.
>
> Intent Solutions builds the customer-owned alternative, open source under Apache-2.0:
>
> • **CCSC** — a governance kernel: a deterministic per-tool-call policy engine, human-in-command approval for consequential actions, and a signed, offline-verifiable audit log you check with your own public key. No vendor in the trust path.
> • **AGP** — reimplements and hardens that kernel with a self-hosted sandbox that proves its network isolation, and a signed-HEAD checkpoint that detects a truncated log a plain hash chain cannot.
>
> This isn't a security critique of Claude Tag — its sandbox and credential handling are genuinely strong. It's an ownership and verifiability position: for regulated, security-conscious, or sovereignty-sensitive teams, the agent, its memory, and its audit trail should be yours, on your infrastructure, provable with your own key.
>
> Both models are legitimate. The right one depends on who must own the substrate — and who must be able to prove what happened.
>
> Read the technical deep-dive: [LINK: startaitools deep-dive]
> CCSC: https://github.com/jeremylongshore/claude-code-slack-channel
> AGP: https://github.com/jeremylongshore/agent-governance-plane
>
> #AIagents #AIgovernance #EnterpriseAI #Slack #OpenSource #AIsecurityCompliance

---

### Posting notes for Jeremy
- **Sequence:** post AFTER the #3 startaitools deep-dive is live, so every link resolves.
- **Verify before posting:** the Agent-Proxy "deny-by-default egress / keys never reach the model" line traces to launch coverage — if you want to be airtight, phrase as "per Anthropic's launch coverage." (Flagged in `_research/anthropic-facts.md`.)
- All three avoid banned terms (no "tamper-proof / forensic-grade / compliance-grade"). "Signed, offline-verifiable" throughout.
- Personal = your operator voice (restaurant/trucking → "you need a record you can prove"). Company = measured, still direct. Adjust hashtags to taste.
