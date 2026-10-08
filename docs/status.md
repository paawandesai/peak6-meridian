<!-- OWNER: operator. -->
# Status

_Last updated: 2026-10-07 12:05 CT by operator (merge main into M1-09 after D-047; OQ-12 option b on MR !9)._

## Current milestone
**M1: Core lifecycle, local** (ends Wed Oct 7 23:59 ET). Tickets: [tickets/M1.md](tickets/M1.md). Next anchor: Thu Oct 8 16:05 ET devnet rehearsal settlement.

## Done
- Kickoff pack.
- M1-01 · Scaffold the monorepo and GitLab CI (MR !2, merged 2026-10-06 as `52dcb6d`).
- Post-M1-01 gates: Pipelines-must-succeed **on**; daily `HEARTBEAT=1` schedule **id 20**; main post-merge pipelines green.
- Ops docs: runbook (!1), runner-maintenance log (!3), D-045 (!6), post-M1-01 docs (!4), status after M1-03/M1-08 (!11).
- M1-03 · Matching engine crate (MR !5, merged as `b91e208`).
- M1-08 · Strike calculator and NYSE calendar (MR !7, merged as `eb5fe77`).
- M1-11 · Ops-agent safety layer + evals (MR !10, merged as `a1c486a`).
- M1-02 · Program skeleton (MR !8, merged 2026-10-07 as `ecf72eb` / squash `a3840c1`).

## In progress
- M1-09 · Switchboard feed definitions and spike (MR !9; OQ-12 **(b)** applied: in-repo `packages/bigint-buffer-js` + `pnpm.overrides`; awaiting CI green + Cursor APPROVE).

## Queued / blocked on deps
- M1-04 (after M1-02), then M1-05 (needs M1-03+M1-04), M1-07 (after M1-04), M1-06 (after M1-05), M1-12 (after M1-04), M1-10 (after M1-06/07/08).

## Blocked
- M1-09 live spike / feed create on devnet: needs keys usable outside sandbox (see OQ-2 / OQ-11). Offline `--dry-run` is the CI path.

## Awaiting human veto
- D-048 · UI clarity and usability pass (`/design` spec → UI-01, then UI-02+ tickets). **Already approved** by Paawan 2026-10-07 ~20:32 CT; listed for visibility.

## Open questions
| ID | Question | Owner | Blocks |
|---|---|---|---|
| OQ-1 | Does Gauntlet require anything beyond the deliverables in brief.md (written report, post, form)? | human | M4 |
| OQ-2 | Credentials needed (Tier 3, one batch): Tiingo, Twelve Data, Finnhub API keys; Anthropic API key; Vercel and Railway tokens; GitLab token for the operator. | human | M1-09 live spike, M2 deploys, M3 agent |
| OQ-3 | Pyth inquiry outcome; if Pyth grants equities on devnet, decide whether to switch adapters (D-005). | human | none (Switchboard is default) |
| OQ-4 | Switchboard spike: can the feed job itself verify the bar date, and can API keys stay out of public feed definitions? (domain.md § Settlement rules) | M1-09 | M2 settlement |
| OQ-5 | Custody of the devnet program keypair, upgrade authority and admin keypair (generated where, backed up by whom). | human | M2 devnet deploy |
| OQ-6 | Any `cargo audit` advisories from upstream Solana/Anchor crates with no fix: accept (human) or replace. | human | none (see OQ-7; OQ-10 accepted as D-047 for LiteSVM dev-deps) |
| OQ-7 | M1-01 `cargo audit` result (answers part of OQ-6): 0 vulnerabilities, so `audit:deps` passes. It prints 3 informational warnings, all from upstream Solana 2.1 / Anchor 0.31.1 crates with no fixed version on that line: RUSTSEC-2025-0141 (`bincode` 1.3.3 unmaintained), RUSTSEC-2025-0161 (`libsecp256k1` 0.6.0 unmaintained), RUSTSEC-2026-0097 (`rand` 0.7.3 unsound with a custom logger). Nothing is silenced. Accept these warnings, or make warnings fail the job? | human | none (job is green) |
| OQ-8 | NFR-18 "CI pipeline ≤ 20 min" is at risk. CI runs on one 1 vCPU / 2 GB host (`w2-ci-runner`) that serves both runners: #291 `meridian` (untagged jobs) and #235 (jobs tagged `heavy`, i.e. `e2e`; job limit raised to 60 min by the human on 2026-10-06). Measured on the first M1-01 pipeline (39093, cold caches): `guard:human-files` 39 s, `secrets:gitleaks` 6 s, `typecheck` 161 s, `lint` 388 s, `audit:deps` 1,799 s (of which 1,647 s is the one-off `cargo install cargo-audit`; the audit itself takes 49 s). Tool builds are cached per runner afterwards, so only the first pipeline on a runner, or one that changes `scripts/toolchain.sh` / `rust-toolchain.toml`, pays them. Warm timings and the remaining jobs: MR !2. Later tickets add heavier crates (LiteSVM, Switchboard). Options: a larger runner (4+ vCPU / 8 GB), or a prebuilt CI image (M1-01 defers it). | human | NFR-18 |
| OQ-9 | M1-02 config tickers written in ≤6 slots per call (packet/IDL limits). Confirm after !8 merge (`ecf72eb`). | operator→human | none |
| OQ-10 | **RESOLVED / accepted 2026-10-07 ~10:17 CT (Paawan) → [D-047](decisions.md).** Six `.cargo/audit.toml` ignores for LiteSVM **dev-deps only** (RUSTSEC-2022-0093, 2024-0344, 2026-0258, 2026-0098, 2026-0099, 2026-0104). NFR-10 / AB-16 still enforced; advisories only via LiteSVM (D-017); same family as OQ-6/OQ-7; remove when Agave ≥ 2.2; PRD security goals unchanged. | human | — |
| OQ-11 | M1-09 live spike (AC3): **blocked: needs keys.** Offline `--dry-run` covered in CI. Manual (devnet only; ~0.5 SOL airdrop): `pnpm tsx scripts/switchboard/create-feeds.ts --cluster devnet --keypair <funded>`, put `SWITCHBOARD_FEEDS_JSON=…` in `.env`, then `pnpm tsx scripts/switchboard/spike.ts --cluster devnet` with keys exported. Options: (a) human runs commands; (b) allow agent key egress for this run. | human | OQ-4 answer, M2 settlement |
| OQ-12 | **Resolved (D-046):** chose option **(b)** isolate/override. `pnpm.overrides` `@solana/buffer-layout-utils>bigint-buffer` → `link:./packages/bigint-buffer-js` (upstream 1.1.5 pure-JS path, native addon removed). JS fallback matches upstream 1.1.5 semantics; u64/u128 layout behavior through `@solana/buffer-layout-utils` / Switchboard SDK chain unchanged (no feature loss). Rejected (a) audit ignore and (c) third-party forks. | operator (human-approved) | none (`audit:deps` should pass without ignore) |
| OQ-13 | M1-12 (!17): `pnpm audit` HIGH GHSA-vfj7-8cjw-p6xm (`braces` <=3.0.3, stack-exhaustion DoS), no patched version exists (3.0.3 is the latest). Only path: `app` > `@solana/wallet-adapter-react` > `@solana-mobile/wallet-adapter-mobile` > `react-native` > `metro` > `micromatch` > `braces`: React Native build tooling, never in the browser bundle. Ignored via root `package.json` `pnpm.auditConfig.ignoreGhsas` (operator-approved 2026-10-07 21:20 CT); remove when `braces` is patched or wallet-adapter drops the mobile adapter. Operator to log in decisions.md. | human | none |
| OQ-14 | UI-01 (MR !22): **pre-open behaviour.** docs/domain.md says 09:00 visible and mintable, 09:30 open, but the program has no 09:30 gate (`Market` has no open time; mint and orders are blocked only by pause and `now ≥ close_ts`). Options: (a) UI shows `Open` and allows every intent from creation, adding no pre-open state (**recommended**: matches the program, nothing to bypass); (b) add an on-chain `open_ts` to `Market` (its own ticket), then an "Opens 09:30 ET" state with mint only. | human | UI-02/UI-03 state badge |
| OQ-15 | UI-01 (MR !22): **`packages/client` exception for display formatting.** UI tickets may not touch `packages/client`, but the spec's money strings need five display-only helpers in `units.ts` (`scaledToCentsFloor`, `formatUsdCents`, `formatUsdcBalance`, `formatPriceTenths`, `formatUsdSigned`; design.md §3), added once in UI-02 with fast-check tests. Options: (a) allow this single additive exception in UI-02 (**recommended**: one source for money strings, floor rounding so a displayed price never contradicts an outcome); (b) a separate client ticket first, with UI-02 depending on it; (c) format in `app/` (rejected: breaks "amounts only through client helpers"). | human | UI-02 |
| OQ-16 | M1-07 (MR !18): the `build-devnet-check` CI job (AB-22: `make build-devnet`, assert the IDL has no `local_oracle_set`) is **held** by the operator because `.gitlab-ci.yml` is human-owned. Patch: `/tmp/m1-07-ci-job/0001-ci-HUMAN-OWNED-.gitlab-ci.yml-needs-Paawan-s-review-.patch`; it also sets `MERIDIAN_DEVNET_IDL` so the built-IDL test in `tests/security/program/tests/ab_22_devnet_build.rs` runs (the test is `#[ignore]`d, shown as ignored not passed, and the job runs it with `-- --include-ignored`). **AB-22 built-IDL evidence stays open until this job is applied.** Needs: Paawan to apply or approve the CI change. | human | M1-07 AC3 (AB-22 built-IDL check in CI) |

## Requirements coverage
| ID | Status |
|---|---|
| FR-01 | met (M1-02 `initialize_config` + client config on main via !8 / `ecf72eb`) |
| FR-02 | not started |
| FR-03 | not started |
| FR-04 | not started |
| FR-05 | partial (M1-03 book crate on main; on-chain place/cancel/settle = M1-05) |
| FR-06 | not started |
| FR-07 | not started |
| FR-08 | in progress (M1-09 feeds !9; on-chain settle = M1-07) |
| FR-09 | not started |
| FR-10 | not started |
| FR-11 | partial (M1-02 pause/unpause stubs + AB-06 path on main; full behavior with instruction tickets) |
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
| FR-27 | partial (M1-11 safety layer + evals on main via !10; live agent = M3) |
| FR-28 | not started |
| FR-29 | not started |
| FR-30 | partial (M1-01: `make e2e` placeholder, `make dev` stub; lifecycle scripts from M1-10) |
| FR-31 | not started |
| FR-32 | not started |
| FR-33 | partial (M1-02 events declared on main; emitters with instruction tickets) |
| NFR-01 | not started |
| NFR-02 | partial (M1-03 max-8 fills; CU assert in M1-05) |
| NFR-03 | not started |
| NFR-04 | not started |
| NFR-05 | partial (M1-08 libs; idempotent create-markets = M1-10) |
| NFR-06 | in progress (M1-09 offline spike; live + on-chain = later) |
| NFR-07 | partial (M1-03 book properties ≥1k; program invariants later) |
| NFR-08 | partial (M1-02 AB-06 admin-only on main; override delay = M1-07) |
| NFR-09 | partial (M1-03 AB-09/10; program order ABs later) |
| NFR-10 | partial (M1-01 audits + AB-16/AB-17; OQ-10 LiteSVM ignores accepted D-047; !9 clearing `bigint-buffer` via OQ-12(b)) |
| NFR-11 | met for M1 safety gate (M1-11 !10: AB-14/15/20 + schema/range validation; live agent = M3) |
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
| _none_ | | | M1-01 AB-16/17/22; M1-02 LiteSVM audit ignores accepted (D-047 / OQ-10); M1-03 AB-09/10; M1-11 AB-14/15/20 — no open findings |
