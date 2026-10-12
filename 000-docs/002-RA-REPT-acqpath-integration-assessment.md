# AcqPath integration assessment and decision

Assessment date: 2026-10-11, UTC−06:00. Related issue:
[#297](https://github.com/jeremylongshore/claude-code-slack-channel/issues/297).
Tracking: `ccsc-6v9`.

## Decision

Decline the AcqPath integration proposal and close issue #297 as not planned.
The maintainer selected this disposition after reviewing the commercial,
technical, privacy, and security tradeoffs below. CCSC will retain its existing
scope; this decision introduces no integration or policy change.

AcqPath addresses a plausible evidence need for applications ingesting public
web content. For CCSC, the demonstrated benefit does not justify an external
service, payment workflow, and additional operational obligations. The
[roadmap](../ROADMAP.md) prioritizes a small, auditable Slack governance kernel
and places extensions downstream.

## Contributor identity and commercial incentives

The public account `reflectme-source` publishes AcqPath's distribution repository.
GitHub records the account creation date as December 21, 2025. Its profile supplies
no personal name, company, or biography. The reviewed public materials did not
establish a named individual or accountable legal business. Counterparty identity
therefore remains unverified. This is not evidence of wrongdoing.
[GitHub profile](https://github.com/reflectme-source),
[profile metadata](https://api.github.com/users/reflectme-source).

The issue forms part of a broad commercial outreach campaign. A GitHub API
snapshot for `"AcqPath" is:issue`, filtered to author `reflectme-source` and
deduplicated by issue ID, returned at least 846 matching issues, including 698
created on October 5. The search reported 852 total results; pagination yielded
849 distinct issues, of which 846 matched the author. These are snapshot counts,
not a claim of a complete or permanently stable census. The wording of CCSC's
proposal closely matches the
[ByteYellow proposal](https://github.com/ByteYellow/AgentProvenance/issues/29).

AcqPath's own [outreach log](https://github.com/reflectme-source/acqpath-distribution/blob/a9526046c52efad0b7e78f810a3eafa91ee67438/WAVE1_LIVE.md)
records integration pitches as customer acquisition. Its
[partner trial](https://developers.getacqpath.com/partners/proof-sprint)
seeks a rapid commercial decision after a small number of events.
The assessment is that paid usage, distribution, and integration credibility
motivate the proposal. The repeated wording and closely spaced submissions
suggest automated outreach; neither observation establishes malicious intent.

## Proposed service and its limits

An application sends AcqPath a public URL and an intended use such as AI input,
indexing, training, or search. AcqPath observes machine-readable source
declarations and returns signed evidence for the application's own policy and
audit records. [Evidence contract](https://developers.getacqpath.com/partners/evidence-contract).

The underlying [Really Simple Licensing standard](https://rslstandard.org/)
is open. AcqPath sells observation and evidence services around declarations;
using the standard does not require buying this particular service.

A valid signature establishes that the holder of AcqPath's signing key signed
the statement. It does not establish the publisher's ownership, the correctness
of the declaration, or the legality of a particular downstream use. AcqPath's
[terms](https://getacqpath.com/terms) acknowledge those limits. Purchasing a report
does not itself acquire a content license or compensate the publisher.

## Benefits and tradeoffs

| Area | Potential benefit | Cost or limitation |
| --- | --- | --- |
| Audit evidence | Preserve what a source declared at a particular time. | Trust in the observer remains necessary, as does retention of verifiable evidence. |
| Policy consistency | Represent restrictions, missing declarations, and unavailable evidence consistently. | Overly strict handling could block useful work when declarations are absent; existing licenses still need separate consideration. |
| Engineering effort | Outsource discovery, parsing, caching, and evidence signing. | Add a vendor dependency and ongoing maintenance. |
| Economics | Small experiments can be inexpensive. | Fresh reports cost 0.02 USDC each; 10,000 reports cost 200 USDC before other costs. Some UNKNOWN diagnostics are billable. |
| Publisher interests | Make declared usage preferences more visible. | The report purchase itself provides no publisher license or royalty. |

Prices and billable-UNKNOWN capabilities were advertised by the
[live capability endpoint](https://api.getacqpath.com/v1/capabilities) at the
assessment date. They are observations of the service contract, not guaranteed
future prices or measured end-to-end purchase results.

## Security and privacy assessment

The reviewed [Evidence Bridge implementation](https://github.com/reflectme-source/acqpath-distribution/blob/a9526046c52efad0b7e78f810a3eafa91ee67438/packages/evidence-bridge/index.mjs)
performs Ed25519 signature verification, compares the signed payload with the
returned report, and checks the requested URL and purpose. It separates evidence
from the consumer's authorization decision. These are useful controls. Signature
verification does not itself enforce freshness; consumers need an explicit
policy for stale or missing observation timestamps.

Material integration risks remain:

- **Information disclosure.** Resource URLs, including paths, and intended use
  can reveal customer interests or research strategy even when the resource is
  public. The [data handling statement](https://getacqpath.com/data-handling)
  describes Cloudflare processing, a US-hosted Railway relay, a default 30-day
  report retention period, and separately retained financial records. It does
  not establish an existing blanket data processing agreement, EU-only
  processing commitment, or deletion SLA.
- **Payment authorization.** Paid report retrieval adds wallet and authorization
  handling. The documented stock route allows a leaked, unused authorization to
  be raced before its first request binding. Spending caps, confidential payment
  state, and safe retry behavior would be necessary for an automated buyer.
  [Payment guidance](https://github.com/reflectme-source/acqpath-distribution/blob/a9526046c52efad0b7e78f810a3eafa91ee67438/README.md#separate-stock-marketplace-mode).
- **False confidence.** Favorable usage declarations do not establish that page
  content is safe for an agent. All existing CCSC prompt-injection, access,
  outbound, and approval safeguards remain necessary. Provider output must not
  become executable instructions or a self-authorizing policy decision.
- **Backend assurance.** The public repository contains clients and distribution
  materials, excluding the production backend. Its advertised fetching controls
  could not be independently verified from those materials. An independent
  backend security audit was not established by this assessment.
  [Repository scope](https://github.com/reflectme-source/acqpath-distribution/blob/a9526046c52efad0b7e78f810a3eafa91ee67438/README.md#verification-and-operating-scope).
- **Availability and maintenance.** Enforcement would couple content workflows
  to an external service's availability and interpretation. An observation-only
  integration could avoid blocking existing operations, while still incurring
  data disclosure, cost, retention, and maintenance obligations.

The public-source assessment and limited client inspection do not constitute
a backend audit or a paid transaction test.

## Product maturity and documentation consistency

The published [revenue scoreboard](https://github.com/reflectme-source/acqpath-distribution/blob/a9526046c52efad0b7e78f810a3eafa91ee67438/REVENUE_SCOREBOARD.md)
reports zero verified independent payers at its last recorded baseline. This is
historical, self-reported evidence and does not establish the current customer
count.

Several [developer pages](https://developers.getacqpath.com/) describe coverage
limited to four origins, while the live capability endpoint advertises dynamic
public-HTTPS inspection. The stock payment route remains restricted to reviewed
origins according to the current product documentation. The service terms also
retain language requiring legal and billing review before paid production
launch, although the capability endpoint advertises live payments. These
inconsistencies require reconciliation before relying on production assurances;
they do not by themselves prove an implementation defect.

## Fit for CCSC and any future reconsideration

The likely beneficiaries are applications ingesting substantial public-web
content that have a concrete need for declaration history. Ordinary Slack-to-Claude
users would inherit additional cost and complexity without an established
benefit. A specialist content-ingestion or governance component is a more natural
integration boundary than the CCSC core.

Any future reconsideration would require a demonstrated CCSC user need, an
identified service operator, customer references, security evidence, clear data
terms, and measured usefulness on representative sources. An experiment would
need separate authorization, explicit opt-in, spending caps, minimal public-URL
disclosure, and observation-only behavior initially. CCSC would retain control of
its evidence format and policy. No experiment is planned under this decision.

Issue #297 was closed as not planned on October 12, 2026, at 04:11:54 UTC
(October 11 at UTC−06:00). The
[maintainer response](https://github.com/jeremylongshore/claude-code-slack-channel/issues/297#issuecomment-6117603704)
thanks the contributor and explains the scope decision. The disposition makes
no accusation about the contributor.
