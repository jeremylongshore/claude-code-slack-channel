# Community response to Ben's Claude Tag video (AI Circle)

**DRAFT — for Jeremy's review before posting to the AI Circle community.**
Respectful, credit-first. Grounded in Ben's actual video structure (`_ben-video-grounding.md`). Do **not** attribute spoken-word quotes beyond the two verbatim lines Ben wrote. Replace `[LINK: deep-dive]` with the live URL post-publish.

---

**Ben — this was a great walkthrough, and you're right that this is a big deal.** 🙌

Your framing landed for me, especially for the audience you build for. You took people from "what is this" straight through **the 6 features → why it's a big deal → setup → general vs. channel-specific agents → autonomous & scheduled tasks → a second brain in Slack** — and that's exactly the arc a non-technical business owner needs to actually *get moving* with Claude Tag. The setup really is that frictionless, and you're not overselling when you say it changes how businesses use AI. You even called it in the description: *"This is bigger than I thought it would be. Very cool."* Agreed.

I want to build on it, not argue with it — add the layer I think your "$1M ARR" audience will run into *next*, once Claude Tag is doing real work for them.

**Your last chapter is the whole thing: "Second Brain in Slack."** That second brain — the memory Claude builds as it lives in your channels — is genuinely the killer feature. So the follow-up question every business owner should ask is simply: **whose second brain is it, and can you prove what it did?**

Here's the honest picture, and I want to be fair to Anthropic because they did strong engineering:

- Claude Tag runs in an **isolated sandbox on Anthropic's infrastructure**, and when it touches your tools, credentials are kept away from the model — and, per its launch coverage, egress defaults to deny. That's good security. Nothing sketchy here.
- **But that second brain — your org's memory — is Anthropic's proprietary state.** It's scoped to your channels, but it lives on their infra. If you ever want to move to another agent or another vendor, that accumulated context isn't an exportable file you carry with you. AlphaSignal put the principle nicely: *rent the agent, own the memory* — and Claude Tag inverts it.
- The governance you get is **coarse**: which channels, which tools, and a spend cap. What you don't get is a **human approval before each consequential action**, or an **audit log you can verify yourself** rather than one the vendor shows you.

For a ton of use cases — drafting, summarizing, chasing routine tasks — none of that matters and Claude Tag is the right call. **Use it.** But the moment that second brain is approving refunds, messaging customers, or touching a codebase, "trust the vendor's log" becomes a real business question, especially if you're in anything regulated.

That's the gap a couple of open-source projects were built for, and I mention them only because they're the concrete other-half of your video, not a pitch:

- **CCSC** decides *per tool call* whether an action is allowed, denied, or needs a human to approve it — and writes a **signed audit log you can verify with your own key**, on your own infrastructure.
- **AGP** adds a self-hosted sandbox and closes a subtle gap: it can prove the log wasn't quietly *truncated* — that nothing got cut off the end.

Same idea as your second brain, one ownership question deeper: **make the brain — and the record of what it did — yours.**

So: rent the agent for speed (you nailed why), and when the stakes go up, own the substrate. Both are legit. Thanks for putting this out, Ben — it's the clearest Claude Tag tour I've seen, and it's exactly why the ownership conversation is worth having now, while everyone's setting theirs up.

*If it's useful to anyone here, I wrote up the technical side — per-action approval + verifiable audit + self-hosting — here: [LINK: deep-dive]. Repos are open source (Apache-2.0): github.com/jeremylongshore/claude-code-slack-channel and github.com/jeremylongshore/agent-governance-plane.*

- Jeremy Longshore
intentsolutions.io

---

### Notes for Jeremy
- Tone = teammate adding a chapter, not a critic. Opens and closes on genuine credit; the ownership angle is framed as "the next question," bridged off Ben's own chapter 8 ("Second Brain in Slack").
- Only two Ben quotes used, both verbatim from his description ("bigger than I thought…very cool"; the "$1M ARR / non-technical" positioning). **No fabricated narration.**
- If posting somewhere the footer signature isn't wanted (e.g. a Skool/Discord comment vs. a written article), drop the `- Jeremy Longshore / intentsolutions.io` line.
- Verify the Agent-Proxy detail phrasing per `_research/anthropic-facts.md` before posting (soften to "per launch coverage" if you want it airtight).
