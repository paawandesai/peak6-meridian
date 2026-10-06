<!-- OWNER: operator. -->
# Status

_Last updated: 2026-10-06 14:30 ET by kickoff._

## Current milestone
**M1: Core lifecycle, local** (ends Wed Oct 7 23:59 ET). Tickets: [tickets/M1.md](tickets/M1.md). Next anchor: Thu Oct 8 16:05 ET devnet rehearsal settlement.

## Done
- Kickoff pack.

## In progress
_None yet._

## Blocked
_None yet._

## Awaiting human veto
_None._

## Open questions
| ID | Question | Owner | Blocks |
|---|---|---|---|
| OQ-1 | Does Gauntlet require anything beyond the deliverables in brief.md (written report, post, form)? | human | M4 |
| OQ-2 | Credentials needed (Tier 3, one batch): Tiingo, Twelve Data, Finnhub API keys; Anthropic API key; Vercel and Railway tokens; GitLab token for the operator. | human | M1-09 live spike, M2 deploys, M3 agent |
| OQ-3 | Pyth inquiry outcome; if Pyth grants equities on devnet, decide whether to switch adapters (D-005). | human | none (Switchboard is default) |
| OQ-4 | Switchboard spike: can the feed job itself verify the bar date, and can API keys stay out of public feed definitions? (domain.md § Settlement rules) | M1-09 | M2 settlement |
| OQ-5 | Custody of the devnet program keypair, upgrade authority and admin keypair (generated where, backed up by whom). | human | M2 devnet deploy |
| OQ-6 | Any `cargo audit` advisories from upstream Solana/Anchor crates with no fix: accept (human) or replace. | human | M1-01 `audit:deps` |
| OQ-7 | M1-01 `cargo audit` result (answers part of OQ-6): 0 vulnerabilities, so `audit:deps` passes. It prints 3 informational warnings, all from upstream Solana 2.1 / Anchor 0.31.1 crates with no fixed version on that line: RUSTSEC-2025-0141 (`bincode` 1.3.3 unmaintained), RUSTSEC-2025-0161 (`libsecp256k1` 0.6.0 unmaintained), RUSTSEC-2026-0097 (`rand` 0.7.3 unsound with a custom logger). Nothing is silenced. Accept these warnings, or make warnings fail the job? | human | none (job is green) |
| OQ-8 | The only CI runner (#235) has 1 vCPU / 2 GB RAM. Job limit was raised to 60 min on 2026-10-06, but NFR-18 "CI pipeline ≤ 20 min" holds only with warm caches and is at risk once later tickets add heavier crates (LiteSVM, Switchboard). Options: a larger runner (4+ vCPU / 8 GB), or a prebuilt CI image (ticket M1-01 defers it). Timings: MR for M1-01. | human | NFR-18 |

## Requirements coverage
| ID | Status |
|---|---|
| FR-01 | not started |
| FR-02 | not started |
| FR-03 | not started |
| FR-04 | not started |
| FR-05 | not started |
| FR-06 | not started |
| FR-07 | not started |
| FR-08 | not started |
| FR-09 | not started |
| FR-10 | not started |
| FR-11 | not started |
| FR-12 | not started |
| FR-13 | not started |
| FR-14 | not started |
| FR-15 | not started |
| FR-16 | not started |
| FR-17 | not started |
| FR-18 | not started |
| FR-19 | not started |
| FR-20 | not started |
| FR-21 | not started |
| FR-22 | not started |
| FR-23 | not started |
| FR-24 | not started |
| FR-25 | not started |
| FR-26 | not started |
| FR-27 | not started |
| FR-28 | not started |
| FR-29 | not started |
| FR-30 | not started |
| FR-31 | not started |
| FR-32 | not started |
| FR-33 | not started |
| NFR-01 | not started |
| NFR-02 | not started |
| NFR-03 | not started |
| NFR-04 | not started |
| NFR-05 | not started |
| NFR-06 | not started |
| NFR-07 | not started |
| NFR-08 | not started |
| NFR-09 | not started |
| NFR-10 | not started |
| NFR-11 | not started |
| NFR-12 | not started |
| NFR-13 | not started |
| NFR-14 | not started |
| NFR-15 | not started |
| NFR-16 | not started |
| NFR-17 | not started |
| NFR-18 | not started |

## Security findings
| ID | Severity | Status | Ticket |
|---|---|---|---|
| _none yet_ | | | |
