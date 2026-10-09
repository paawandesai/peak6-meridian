# M4-04 Red-Team Pass Log

**Date:** 2026-10-09  
**Build:** Final build against origin/main (merged)  
**Test tool:** `make test-security` (executes Rust program tests, TS tests via vitest, Python tests via pytest)

## Methodology

Executed all AB-01 through AB-22 abuse-case tests against the codebase using `make test-security`. Each AB is tested via dedicated test files in `tests/security/{program,ts,py}/`. Tests run against LiteSVM (program tests), Node.js runtime (TS tests), and Python runtime (Python tests).

## AB-01 through AB-22: Test Results

| AB ID | Attack Vector | Test File(s) | Tool | Outcome | Notes |
|-------|---------------|--------------|------|---------|-------|
| AB-01 | Mint without escrow / Mint more than paid | `tests/security/program/tests/ab_01_minting.rs` | cargo test | SAFE | 5 tests passed. Mint rejects non-escrow, wrong authority, wrong amount |
| AB-02 | Redeem without burning / Steal vault | `tests/security/program/tests/ab_02_redeem.rs` | cargo test | SAFE | 3 tests passed. Redeem checks burn, validates quantities |
| AB-03 | Stale or wrong trading date oracle | `tests/security/program/tests/ab_03_ab_05_timing.rs`<br/>`tests/security/ts/ab_03_stale_or_wrong_date.test.ts` | cargo test<br/>vitest | SAFE | Program: 5 tests passed (wrong date, stale feed rejected)<br/>TS: 8 tests passed (check-feeds script validation) |
| AB-04 | Spoofed oracle accounts | `tests/security/program/tests/ab_04_oracle_spoof.rs`<br/>`tests/security/ts/ab_04_spoofed_feed.test.ts` | cargo test<br/>vitest | SAFE | Program: 8 tests passed (wrong owner, hash, account rejected)<br/>TS: 10 tests passed (off-chain validation) |
| AB-05 | Settle before close_ts | `tests/security/program/tests/ab_03_ab_05_timing.rs`<br/>`tests/security/ts/ab_05_settle_before_close.test.ts` | cargo test<br/>vitest | SAFE | Program: Timing guard tests passed<br/>TS: 6 tests passed (automation guard) |
| AB-06 | Non-admin calls admin instructions | `tests/security/program/tests/ab_06_admin_only.rs` | cargo test | SAFE | 3 tests passed. Admin-only instructions reject non-admin |
| AB-07 | Admin override without delay | `tests/security/program/tests/ab_07_ab_08_override.rs` | cargo test | SAFE | 8 tests passed. Delay enforced, early override rejected |
| AB-08 | Admin override with wrong price | `tests/security/program/tests/ab_07_ab_08_override.rs` | cargo test | SAFE | Included in AB-07 tests. Price validation enforced |
| AB-09 | Forged open orders / Credit theft | `tests/security/program/tests/ab_09_ab_10_book.rs`<br/>`tests/security/program/tests/ab_09_orders.rs` | cargo test | SAFE | 4 tests passed. Open orders validated, credit guards enforced |
| AB-10 | Price manipulation via book state | `tests/security/program/tests/ab_09_ab_10_book.rs` | cargo test | SAFE | Book integrity tests passed |
| AB-11 | Orders/minting during pause or after close | `tests/security/program/tests/ab_11_close_pause.rs` | cargo test | SAFE | 7 tests passed. Pause/close guards enforced per instruction |
| AB-12 | Integer overflow in mint/redeem | `tests/security/program/tests/ab_12_overflow.rs` | cargo test | SAFE | 4 tests passed. Overflow checks on all financial operations |
| AB-13 | Oracle feed spread > max_conf_bps | `tests/security/program/tests/ab_13_oracle_spread.rs`<br/>`tests/security/ts/ab_13_feed_spread.test.ts` | cargo test<br/>vitest | SAFE | **NEW**: Program: 5 tests passed (on-chain spread guard)<br/>TS: 8 tests passed (off-chain check-feeds validation) |
| AB-14 | Command injection in ops-agent | `tests/security/py/ab_14_injection.py` | pytest | SAFE | 75 tests passed. All user inputs validated, no shell injection |
| AB-15 | Draft price outside valid range | `tests/security/py/ab_15_draft_range.py` | pytest | SAFE | 7 tests passed. Price bounds enforced |
| AB-16 | Unlocked/mutable dependencies | `tests/security/ts/ab_16_locked_dependencies.test.ts` | vitest | SAFE | 11 tests passed. All deps pinned in package.json, Cargo.toml, pyproject.toml |
| AB-17 | Committed secrets or deploy key exposure | `tests/security/ts/ab_17_deploy_secrets.test.ts`<br/>`tests/security/ts/ab_17_no_committed_secrets.test.ts` | vitest | SAFE | 4 tests passed. Gitleaks checks, no secrets in repo |
| AB-18 | Intent instruction validation bypass | `tests/security/ts/ab_18_intents.test.ts` | vitest | SAFE | 17 tests passed. All intent validation enforced |
| AB-19 | Automation wallet key exposure | `tests/security/ts/ab_19_automation_key.test.ts` | vitest | SAFE | 8 tests passed. Key handling validated |
| AB-20 | LLM jailbreak / prompt injection | `tests/security/py/ab_20_jailbreak.py` | pytest | SAFE | 60 tests passed. All prompts validated, no injection vectors |
| AB-21 | Faucet abuse (rate limits, amount) | `tests/security/ts/ab_21_faucet.test.ts` | vitest | SAFE | 10 tests passed. Rate limits enforced |
| AB-22 | Local oracle in devnet build | `tests/security/program/tests/ab_22_devnet_build.rs`<br/>`tests/security/program/tests/ab_22_local_oracle_feature.rs` | cargo test | SAFE | 7 tests passed. Local oracle gated, not in devnet IDL |

## Summary

- **Total ABs tested:** 22
- **Status:** All SAFE (no vulnerabilities found)
- **New coverage:** AB-13 on-chain spread validation (previously only off-chain test existed)
- **Test execution:** `make test-security` run 2026-10-09 21:36 UTC
- **Program tests:** 63 passed
- **TS tests:** 86 passed, 6 skipped (expected - require specific env/build)
- **Python tests:** 229 passed

## Test Command Output

Full test log captured in `/tmp/m4-04-security-test-log.txt` (2026-10-09 21:36 UTC)

```
Program tests: ok. 63 passed
TS tests: 86 passed | 6 skipped (92)
Python tests: 229 passed in 3.61s
```

## Findings

**None.** All 22 abuse cases validated as safe. The only gap identified was missing on-chain AB-13 test coverage, which this MR fills.
