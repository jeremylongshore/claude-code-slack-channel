# Evidence base — customer-owned, verifiable agent governance

Real, verifiable Semantic Scholar entries gathered 2026-06-30 for the CCSC/AGP deep-dive (#3).
Every entry below resolved via the `semantic-scholar` MCP (`paper_relevance_search`). arXiv IDs / DOIs / Corpus IDs are copied verbatim from the API response so citations are auditable.

## Human oversight / HITL taxonomy (autonomy-vs-control)

1. **Wulf, J., Meierhofer, J., & Hannich, F. (2025).** *Architecting Human-AI Cocreation for Technical Services — Interaction Modes and Contingency Factors.* arXiv:2507.14034. Corpus ID 280053356.
   - Six-mode oversight taxonomy: HOOTL (human-out-of-the-loop) → HAM → HIC (human-in-command, mandatory approval) → HITP → HITL → HOTL (human-on-the-loop). Anchors the "where does per-tool-call approval sit on the spectrum" framing. CCSC/AGP `require` = HIC (mandatory human approval before the action executes).

2. **Navneet, S. K., & Chandra, J. (2025).** *Rethinking Autonomy: Preventing Failures in AI-Driven Software Engineering.* arXiv:2508.11824. Corpus ID 280677534. (6 citations)
   - SAFE-AI framework (Safety, Auditability, Feedback, Explainability): guardrails, sandboxing, runtime verification, risk-aware logging, human-in-the-loop, taxonomy of suggestive/generative/autonomous/**destructive** actions. Cites the **Replit database-deletion incident** as the motivating failure of unsupervised autonomy. Directly supports "gate the destructive action before it runs."

3. **Khan, R., Joyce, D., & Habiba, M. (2025).** *AGENTSAFE: A Unified Framework for Ethical Assurance and Governance in Agentic AI.* arXiv:2512.03180. Corpus ID 283466686. (8 citations)
   - Design/runtime/audit controls; escalates high-impact actions to human oversight; provenance + accountability reinforced through **cryptographic tracing**. Supports the "governance = deny/require/allow + signed provenance" thesis.

4. **Bandara, E., et al. (2026).** *Think Before You Act — A Neurocognitive Governance Model for Autonomous AI Agents.* arXiv:2604.25684. Corpus ID 287834236.
   - Pre-Action Governance Reasoning Loop (PAGRL): consult a governance rule set **before every consequential action**. Independent academic echo of CCSC/AGP's "policy runs before exec." Note: their loop is *model-internal deliberation*; CCSC/AGP make it a *deterministic, external, pre-exec gate* — a sharper guarantee (contrast point, not just support).

## Tamper-evident / transparency-log lineage (verifiable audit)

5. **Yue, C., Dinh, T. T. A., Xie, Z., Zhang, M., Chen, G., Ooi, B. C., & Xiao, X. (2022/2023).** *GlassDB: An Efficient Verifiable Ledger Database System Through Transparency.* Proceedings of the VLDB Endowment. DOI:10.14778/3583140.3583152. Corpus ID 251402915. (27 citations)
   - Frames "transparency logs — a simple abstraction allowing users to verify that a log maintained by an untrusted server is **append-only**." The lineage CCSC's hash-chain + AGP's signed-HEAD checkpoint sit in.

6. **Malkapuram, S., Gangavarapu, S., Kavalakuntla, K. R., & Gangavarapu, A. (2025).** *Context Lineage Assurance for Non-Human Identities in Critical Multi-Agent Systems.* arXiv:2509.18415. Corpus ID 281496529.
   - Anchors agent provenance in **append-only Merkle trees modeled after Certificate Transparency (CT) logs**; a federated proof server lets **external verifiers cryptographically validate multi-hop provenance without access to the full execution trace**. The closest academic analogue to "offline-verifiable signed audit of an agent's action chain." Strong cite for AGP's external-verifier posture.

7. **Baskaran, A., Pherwani, N., & Krishnan, R. (2026).** *Aegon: Auditable AI Content Access with Ledger-Bound Tokens and Hardware-Attested Mobile Receipts.* arXiv:2604.06693. Corpus ID 287247808.
   - CT-style Merkle tree over an append-only ledger enabling **third-party auditors to independently verify records were not retroactively modified**. Supports "the point of a signed log is independent verifiability, not vendor trust."

## Foundational standards CCSC/AGP actually implement (primary sources)

8. **Miller, M. S. (2006).** *Robust Composition: Towards a Unified Approach to Access Control and Concurrency Control.* PhD thesis, Johns Hopkins University.
   - Object-capability model / POLA; origin of the "**advertisements are not grants**" separation CCSC cites in `ARCHITECTURE.md`. (Primary source cited in-repo.)

9. **Laurie, B., Langley, A., & Kasper, E. (2013).** *Certificate Transparency.* RFC 6962, IETF.
   - The append-only signed-log design pattern CCSC's hash-chain and AGP's signed-HEAD checkpoint are descended from.

10. **Rundgren, A., Jordan, B., & Erdtman, S. (2020).** *JSON Canonicalization Scheme (JCS).* RFC 8785, IETF.
    - The canonicalization CCSC/AGP sign over so a signature is reproducible across implementations (`journal.ts` JCS; `jcs-interop.test.ts`).

11. **Bernstein, D. J., Duif, N., Lange, T., Schwabe, P., & Yang, B.-Y. (2012).** *High-speed high-security signatures (Ed25519).* Journal of Cryptographic Engineering, 2(2).
    - The asymmetric signature scheme that makes CCSC/AGP audit logs **publicly** verifiable with only a public key.

## Capability-based security / least authority

12. **Wismüller, R., Ludwig, D., & Breitweiser, F. (2024).** *Extending the Object-Capability Model with Fine-Grained Type-Based Capabilities.* Journal of Object Technology, 23(1). DOI:10.5381/jot.2024.23.1.a1. Corpus ID 267329551.
    - POLA + object-capability paradigm; fine-grained per-operation control. Grounds the "channel scope is coarse; per-tool-call policy is fine-grained authority" argument.

13. **White, O., Jing, Y., Ghosn, A., Steiner, M., Vahldiek-Oberwagner, A., Vij, M., & Vilanova, L. (2025).** *Enabling Cloud-Scale Distributed Capabilities.* HCDS. DOI:10.1145/3723851.3723854. Corpus ID 278054727.
    - Capability-based security offers an application-driven access-control solution; enforcing PoLA at scale mitigates over-privileged access. Supports "coarse RBAC/scope → over-privilege."

14. **Zigmond, E., Chong, S., Dimoulas, C., & Moore, S. (2019).** *Fine-Grained, Language-Based Access Control for Database-Backed Applications (ShillDB).* The Art, Science, and Engineering of Programming, 4(1). arXiv:1909.12279. Corpus ID 182049153.
    - Least-privilege via capabilities + contracts, independent of the underlying system's security. Analogue to CCSC policy sitting above Slack's coarse permissions.

## Prompt injection / tool-integrated agent attack surface (why filters alone are insufficient)

15. **Zhan, Q., Liang, Z., Ying, Z., & Kang, D. (2024).** *InjecAgent: Benchmarking Indirect Prompt Injections in Tool-Integrated Large Language Model Agents.* Findings of ACL 2024. arXiv:2403.02691. Corpus ID 268248325. (**410 citations**)
    - Canonical IPI benchmark; ReAct-GPT-4 vulnerable 24% of the time; two intent classes = direct harm + **private-data exfiltration**. Motivates CCSC's file-exfil guard + inbound gate.

16. **Zhan, Q., Fang, R., Panchal, H., & Kang, D. (2025).** *Adaptive Attacks Break Defenses Against Indirect Prompt Injection Attacks on LLM Agents.* NAACL 2025. arXiv:2503.00061. Corpus ID 276741414. (**89 citations**)
    - Bypasses **all eight** evaluated IPI defenses, >50% ASR. The strongest cite for the thesis: **content filters are not a security boundary — you need deterministic gating + human approval + a signed record of what actually ran.**

17. **Alizadeh, M., Samei, Z., Stetsenko, D., & Gilardi, F. (2025).** *Simple Prompt Injection Attacks Can Leak Personal Data Observed by LLM Agents During Task Execution.* arXiv:2506.01055. Corpus ID 279074865. (29 citations)
    - Tool-calling agents leak personal data observed mid-task; no built-in defense fully prevents leakage. Supports value-firewall / assertNoSecretValues.

18. **Zhang, D., Li, Z., Luo, X., Liu, X., Li, P., & Xu, W. (2025).** *MCP Security Bench (MSB): Benchmarking Attacks Against Model Context Protocol in LLM Agents.* arXiv:2510.15994. Corpus ID 282210053. (23 citations)
    - MCP makes tools first-class composable objects with NL metadata → enlarged attack surface (name-collision, tool-description injection, out-of-scope params). Directly relevant: CCSC *is* an MCP server; its inbound gate + policy engine are the mitigations MSB argues for.

---

### How each maps to a load-bearing claim (traceability)
- **"Filters aren't a boundary; you need a gate + HITL + record"** → [16] (defenses broken), [15] (24% ASR), [17] (leak), [18] (MCP surface).
- **"Approval belongs before execution (HIC on the oversight spectrum)"** → [1] (taxonomy), [2] (destructive-action gating), [4] (pre-action loop).
- **"Verifiable audit = external verification, not vendor trust"** → [5] (transparency logs), [6] (CT-style agent provenance, external verifiers), [7] (third-party auditor), [9]/[11] (RFC 6962 / Ed25519 primary).
- **"Coarse scope over-privileges; fine-grained capability = least authority"** → [8] (Miller/POLA), [12], [13], [14].

> NOTE (fact-check gate): before any artifact publishes, re-confirm each arXiv/DOI resolves and the citation string matches the S2 record. External (non-repo) claims about Anthropic's products live in `_research/anthropic-facts.md`.
