# CCSC — review context for Greptile

CCSC is a **security-critical** Slack ⇄ Claude Code bridge and a known **prompt-injection vector**. Apply extra scrutiny to:

- the **inbound gate** (`gate()`), **outbound gate** (`assertOutboundAllowed()`), and **file-exfiltration guard** (`assertSendable()`) in `lib.ts`;
- the **audit journal** (`journal.ts`) and **policy engine** (`policy.ts`);
- the **session supervisor** (`supervisor.ts`) and anything touching `SessionKey` / session isolation.

Prioritize **correctness, security, and concurrency** findings over style. When a change relaxes a security boundary, says it's "just a test/dev convenience," or edits a frozen design doc to match the code (rather than the reverse), call it out explicitly.
