<!-- OWNER: operator. -->
# Status

_Last updated: 2026-10-07 10:20 CT by operator (OQ-12 option b applied on MR !9)._

## Current milestone
**M1: Core lifecycle, local** (ends Wed Oct 7 23:59 ET). Tickets: [tickets/M1.md](tickets/M1.md). Next anchor: Thu Oct 8 16:05 ET devnet rehearsal settlement.

## Done
- Kickoff pack.
- M1-01 · Scaffold the monorepo and GitLab CI (MR !2, merged 2026-10-06 as `52dcb6d`).
- Post-M1-01 gates: Pipelines-must-succeed **on**; daily `HEARTBEAT=1` schedule **id 20**.
- Ops docs: runbook (!1), runner-maintenance log (!3), D-045 (!6), post-M1-01 docs (!4), status refresh (!11).
- M1-03 · Matching engine crate (MR !5, merged as `b91e208`).
- M1-08 · Strike calculator and NYSE calendar (MR !7, merged as `eb5fe77`).
- M1-11 · Ops-agent safety layer + evals (MR !10, merged as `a1c486a`).
- M1-02 · Program skeleton (MR !8, merged as `ecf72eb` / tip `a3840c1`).

## In progress
- M1-09 · Switchboard feed definitions and spike (MR !9; OQ-12 **(b)** applied: in-repo `packages/bigint-buffer-js` + `pnpm.overrides`; awaiting CI green + Cursor APPROVE).

## Queued / blocked on deps
- M1-04 (after M1-02), then M1-05 (needs M1-03+M1-04), M1-07 (after M1-04), M1-06 (after M1-05), M1-12 (after M1-04), M1-10 (after M1-06/07/08).

## Blocked
- M1-09 live spike / feed create on devnet: needs keys usable outside sandbox (see OQ-2 / MR !9 OQ-11 when merged). Offline `--dry-run` is the CI path.

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
| OQ-6 | Any `cargo audit` advisories from upstream Solana/Anchor crates with no fix: accept (human) or replace. | human | none (see OQ-7; `audit:deps` green with 0 vulns on main pre-LiteSVM) |
| OQ-7 | M1-01 `cargo audit` result (answers part of OQ-6): 0 vulnerabilities, so `audit:deps` passes. It prints 3 informational warnings, all from upstream Solana 2.1 / Anchor 0.31.1 crates with no fixed version on that line: RUSTSEC-2025-0141 (`bincode` 1.3.3 unmaintained), RUSTSEC-2025-0161 (`libsecp256k1` 0.6.0 unmaintained), RUSTSEC-2026-0097 (`rand` 0.7.3 unsound with a custom logger). Nothing is silenced. Accept these warnings, or make warnings fail the job? | human | none (job is green) |
| OQ-8 | NFR-18 "CI pipeline ≤ 20 min" is at risk. CI runs on one 1 vCPU / 2 GB host (`w2-ci-runner`) that serves both runners: #291 `meridian` (untagged jobs) and #235 (jobs tagged `heavy`, i.e. `e2e`; job limit raised to 60 min by the human on 2026-10-06). Measured on the first M1-01 pipeline (39093, cold caches): `guard:human-files` 39 s, `secrets:gitleaks` 6 s, `typecheck` 161 s, `lint` 388 s, `audit:deps` 1,799 s (of which 1,647 s is the one-off `cargo install cargo-audit`; the audit itself takes 49 s). Tool builds are cached per runner afterwards, so only the first pipeline on a runner, or one that changes `scripts/toolchain.sh` / `rust-toolchain.toml`, pays them. Warm timings and the remaining jobs: MR !2. Later tickets add heavier crates (LiteSVM, Switchboard). Options: a larger runner (4+ vCPU / 8 GB), or a prebuilt CI image (M1-01 defers it). | human | NFR-18 |
| OQ-9 | M1-02 config tickers written in ≤6 slots per call (packet/IDL limits). Confirm after !8 merge (`ecf72eb`). | operator→human | none |
| OQ-10 | M1-02 ignores six `cargo audit` advisories reachable only via `litesvm` **dev-deps** (Solana 2.1.21 line; no fix). Same family as OQ-6. Confirm accept after !8 merge. | human | M1-02 CI |
| OQ-11 | M1-09 live spike (AC3): **blocked: needs keys.** Offline `--dry-run` covered in CI. Manual (devnet only; ~0.5 SOL airdrop): `pnpm tsx scripts/switchboard/create-feeds.ts --cluster devnet --keypair <funded>`, put `SWITCHBOARD_FEEDS_JSON=…` in `.env`, then `pnpm tsx scripts/switchboard/spike.ts --cluster devnet` with keys exported. Options: (a) human runs commands; (b) allow agent key egress for this run. | human | OQ-4 answer, M2 settlement |
| OQ-12 | **Resolved (D-046):** chose option **(b)** isolate/override. `pnpm.overrides` `@solana/buffer-layout-utils>bigint-buffer` → `link:./packages/bigint-buffer-js` (upstream 1.1.5 pure-JS path, native addon removed). JS fallback matches upstream 1.1.5 semantics; u64/u128 layout behavior through `@solana/buffer-layout-utils` / Switchboard SDK chain unchanged (no feature loss). Rejected (a) audit ignore and (c) third-party forks. | operator (human-approved) | none (`audit:deps` should pass without ignore) |

## Requirements coverage
| ID | Status |
|---|---|
| FR-01 | in progress (M1-02 !8) |
| FR-02 | not started |
| FR-03 | not started |
| FR-04 | not started |
| FR-05 | partial (M1-03 book crate on main; on-chain place/cancel/settle = M1-05) |
| FR-06 | not started |
| FR-07 | not started |
| FR-08 | in progress (M1-09 feeds !9; on-chain settle = M1-07) |
| FR-09 | not started |
| FR-10 | not started |
| FR-11 | not started (state stubs on !8) |
| FR-12 | not started |
| FR-13 | partial (M1-08 strike + prevCloses library; morning CLI/job = M1-10 / M2) |
| FR-14 | not started (M2) |
| FR-15 | partial→library met (M1-08 calendar; scheduling = M2) |
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
| FR-27 | in progress (M1-11 safety !10; live agent = M3) |
| FR-28 | not started |
| FR-29 | not started |
| FR-30 | partial (M1-01: `make e2e` placeholder, `make dev` stub; lifecycle scripts from M1-10) |
| FR-31 | not started |
| FR-32 | not started |
| FR-33 | in progress (events declared on !8; emitters with instruction tickets) |
| NFR-01 | not started |
| NFR-02 | partial (M1-03 max-8 fills; CU assert in M1-05) |
| NFR-03 | not started |
| NFR-04 | not started |
| NFR-05 | partial (M1-08 libs; idempotent create-markets = M1-10) |
| NFR-06 | in progress (M1-09 offline spike; live + on-chain = later) |
| NFR-07 | partial (M1-03 book properties ≥1k; program invariants later) |
| NFR-08 | in progress (AB-06 on !8; override delay = M1-07) |
| NFR-09 | partial (M1-03 AB-09/10; program order ABs later) |
| NFR-10 | partial (M1-01: gitleaks + self-test, `audit:deps`; AB-16/AB-17; !9 currently red on `bigint-buffer`) |
| NFR-11 | in progress (M1-11 !10) |
| NFR-12 | not started |
| NFR-13 | not started |
| NFR-14 | partial (M1-01 AB-22 feature test; full settle path M1-07) |
| NFR-15 | not started |
| NFR-16 | not started |
| NFR-17 | partial (M1-01: fresh clone + `make toolchain install … e2e` verified; `make dev` from M1-10) |
| NFR-18 | partial (M1-01: 80 % coverage gates active; CI ≤ 20 min only with warm caches, see OQ-8) |

## Security findings
| ID | Severity | Status | Ticket |
|---|---|---|---|
| _none_ | | | M1-01 added AB-16, AB-17, AB-22; M1-03 added AB-09, AB-10 book tests — no open findings |
