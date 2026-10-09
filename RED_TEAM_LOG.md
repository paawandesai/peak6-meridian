# M4-04 Red-Team Pass Log

**Date:** 2026-10-09  
**Build:** Final build against origin/main  
**Validator:** Local `solana-test-validator` with prebuilt program  
**Test suite:** `make test-security` (LiteSVM + off-chain)

## Methodology

Red-team verification via validator e2e exercise + comprehensive LiteSVM regression suite:

### 1. Validator E2E Lifecycle
**Command:** `E2E_REQUIRE_VALIDATOR=1 E2E_PREBUILT=1 make e2e`  
**Runtime:** Local solana-test-validator with deployed `target/deploy/meridian.so`  
**Duration:** 165 seconds, 27 test steps  
**Transcript:** [`VALIDATOR_AB_TEST_LOG.txt`](./VALIDATOR_AB_TEST_LOG.txt)

**ABs exercised on-chain:**
- **AB-01** (mint escrow): Step 8 — trader-b mints 20 pairs on validator
- **AB-02** (redeem): Step 21 — winner redeem for both traders
- **AB-03** (oracle timing): Step 19 — settlement with local oracle feeds
- **AB-11** (closed market): Step 18 — order after close rejected with error
- **AB-18** (intents): Steps 9-15 — all four trade types (BUY YES, SELL YES, BUY NO, SELL NO)
- **AB-21** (faucet limits): Steps 23-27 — concurrent claims, rate limits, bucket rotation

**On-chain TS security tests:** AB-03/04/05 vitest files ran against validator (13 passed, 3 skipped per platform env)

### 2. LiteSVM Regression Suite
**Command:** `make test-security`  
**Results:** [`AB_TESTING_RESULTS.md`](./AB_TESTING_RESULTS.md)

- **Program ABs (01-13, 22):** Anchor instruction logic via LiteSVM (identical bytecode to validator, faster iteration)
- **Off-chain ABs (14-21):** pytest/vitest service tests (ops-agent, automation, faucet)
- **Coverage:** All 22 ABs have regression test coverage

## AB-01 through AB-22: Test Results

| AB ID | Attack Vector | Test File(s) | Validator Exercise | Regression Tests | Outcome |
|-------|---------------|--------------|-------------------|------------------|---------|
| AB-01 | Mint without escrow / Mint more than paid | `ab_01_minting.rs` | E2E step 8 (mint pairs) | LiteSVM: 5 passed | SAFE |
| AB-02 | Redeem without burning / Steal vault | `ab_02_redeem.rs` | E2E step 21 (redeem) | LiteSVM: 3 passed | SAFE |
| AB-03 | Stale or wrong trading date oracle | `ab_03_ab_05_timing.rs`<br/>`ab_03_stale_or_wrong_date.test.ts` | E2E step 19 (settlement) | LiteSVM: 5 passed<br/>Vitest: 8 passed | SAFE |
| AB-04 | Spoofed oracle accounts | `ab_04_oracle_spoof.rs`<br/>`ab_04_spoofed_feed.test.ts` | Vitest on validator | LiteSVM: 8 passed<br/>Vitest: 10 passed | SAFE |
| AB-05 | Settle before close_ts | `ab_03_ab_05_timing.rs`<br/>`ab_05_settle_before_close.test.ts` | E2E step 19 (timing guard) | LiteSVM: included in AB-03<br/>Vitest: 6 passed | SAFE |
| AB-06 | Non-admin calls admin instructions | `ab_06_admin_only.rs` | — | LiteSVM: 3 passed | SAFE |
| AB-07 | Admin override without delay | `ab_07_ab_08_override.rs` | — | LiteSVM: 8 passed | SAFE |
| AB-08 | Admin override with wrong price | `ab_07_ab_08_override.rs` | — | LiteSVM: included in AB-07 | SAFE |
| AB-09 | Forged open orders / Credit theft | `ab_09_ab_10_book.rs`<br/>`ab_09_orders.rs` | — | LiteSVM: 4 passed | SAFE |
| AB-10 | Price manipulation via book state | `ab_09_ab_10_book.rs` | — | LiteSVM: included in AB-09 | SAFE |
| AB-11 | Orders/minting during pause or after close | `ab_11_close_pause.rs` | E2E step 18 (reject after close) | LiteSVM: 7 passed | SAFE |
| AB-12 | Integer overflow in mint/redeem | `ab_12_overflow.rs` | — | LiteSVM: 4 passed | SAFE |
| AB-13 | Oracle feed spread > max_conf_bps | `ab_13_oracle_spread.rs`<br/>`ab_13_feed_spread.test.ts` | — | LiteSVM: 5 passed (NEW)<br/>Vitest: 8 passed | SAFE |
| AB-14 | Command injection in ops-agent | `ab_14_injection.py` | — | Pytest: 75 passed | SAFE |
| AB-15 | Draft price outside valid range | `ab_15_draft_range.py` | — | Pytest: 7 passed | SAFE |
| AB-16 | Unlocked/mutable dependencies | `ab_16_locked_dependencies.test.ts` | — | Vitest: 11 passed | SAFE |
| AB-17 | Committed secrets or deploy key exposure | `ab_17_deploy_secrets.test.ts`<br/>`ab_17_no_committed_secrets.test.ts` | — | Vitest: 4 passed | SAFE |
| AB-18 | Intent instruction validation bypass | `ab_18_intents.test.ts` | E2E steps 9-15 (four intents) | Vitest: 17 passed | SAFE |
| AB-19 | Automation wallet key exposure | `ab_19_automation_key.test.ts` | — | Vitest: 8 passed | SAFE |
| AB-20 | LLM jailbreak / prompt injection | `ab_20_jailbreak.py` | — | Pytest: 60 passed | SAFE |
| AB-21 | Faucet abuse (rate limits, amount) | `ab_21_faucet.test.ts` | E2E steps 23-27 (faucet flow) | Vitest: 10 passed | SAFE |
| AB-22 | Local oracle in devnet build | `ab_22_devnet_build.rs`<br/>`ab_22_local_oracle_feature.rs` | — | LiteSVM: 7 passed | SAFE |

## Summary

**Total ABs:** 22  
**Status:** All SAFE (no vulnerabilities found)  
**Validator exercise:** 6 ABs exercised on-chain via e2e lifecycle (AB-01, AB-02, AB-03, AB-11, AB-18, AB-21)  
**Regression coverage:** All 22 ABs have comprehensive test coverage via LiteSVM + off-chain suites  
**New coverage:** AB-13 on-chain spread guard (filled regression test gap)

### Test Results (make test-security, 2026-10-09)
- **Program tests (LiteSVM):** 63 passed
- **TS tests:** 86 passed, 6 skipped (platform env-specific, expected)
- **Python tests:** 229 passed in 3.61s

### Methodology Rationale
- **Validator e2e:** Exercises critical on-chain paths (mint, redeem, settlement, intents, faucet) on actual solana-test-validator
- **LiteSVM:** Identical Anchor bytecode execution, comprehensive instruction-level regression coverage, faster iteration
- **Combined:** Validator validates deployment + critical flows; LiteSVM validates all program logic paths

## Findings

**None.** All 22 abuse cases validated as safe. AB-13 gap (missing on-chain spread test) filled with new `tests/security/program/tests/ab_13_oracle_spread.rs`.
