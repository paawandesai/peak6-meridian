#!/usr/bin/env bash
# M4-04: Run adversarial attack attempts against local validator per AB-01..AB-22
# Sets E2E_REQUIRE_VALIDATOR=1 so on-chain tests are mandatory, not skipped
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LOG_FILE="/tmp/ab-attacks-$(date +%Y%m%d-%H%M%S).log"
SUMMARY_FILE="/tmp/ab-attacks-summary.txt"

log() { printf '[redteam] %s\n' "$*" | tee -a "$LOG_FILE"; }
result() { printf '%s\n' "$*" | tee -a "$SUMMARY_FILE"; }

log "=== M4-04 Red-Team Attack Attempts ==="
log "Started: $(date)"
log "Log: $LOG_FILE"
log "Summary: $SUMMARY_FILE"
log ""

# Clear summary
> "$SUMMARY_FILE"
result "M4-04 Red-Team Attack Summary"
result "Generated: $(date)"
result ""
result "| AB ID | Attack | Tool | Outcome |"
result "|-------|--------|------|---------|"

# Export E2E_REQUIRE_VALIDATOR=1 so on-chain tests run, not skip
export E2E_REQUIRE_VALIDATOR=1

# Track pass/fail counts
PASS_COUNT=0
FAIL_COUNT=0

run_ab_test() {
    local ab_id="$1"
    local desc="$2"
    local test_file="$3"

    log ""
    log "--- AB-$ab_id: $desc ---"

    if pnpm --filter security-tests run vitest run "$test_file" --reporter=verbose >> "$LOG_FILE" 2>&1; then
        log "PASS: AB-$ab_id"
        result "| AB-$ab_id | $desc | vitest $test_file | SAFE (attacks rejected) |"
        ((PASS_COUNT++))
    else
        log "FAIL: AB-$ab_id (attacks succeeded or test error)"
        result "| AB-$ab_id | $desc | vitest $test_file | FAIL |"
        ((FAIL_COUNT++))
    fi
}

# On-chain program ABs (require validator)
log "Running on-chain attack tests (require validator)..."

run_ab_test "01" "Mint without deposit" "tests/security/ts/ab_01_mint_without_deposit.test.ts"
run_ab_test "02" "Redeem attacks" "tests/security/ts/ab_02_redeem_attacks.test.ts"
run_ab_test "03" "Stale/wrong-date oracle" "tests/security/ts/ab_03_stale_or_wrong_date.test.ts"
run_ab_test "04" "Spoofed oracle" "tests/security/ts/ab_04_spoofed_feed.test.ts"
run_ab_test "05" "Settle before close" "tests/security/ts/ab_05_settle_before_close.test.ts"

# AB-06 through AB-13, AB-22: LiteSVM (Rust program tests)
log ""
log "Running LiteSVM program attack tests..."
if cargo test --manifest-path tests/security/program/Cargo.toml --quiet -- --nocapture >> "$LOG_FILE" 2>&1; then
    log "PASS: AB-06 through AB-13, AB-22 (LiteSVM)"
    result "| AB-06 | Non-admin calls admin fn | cargo test (LiteSVM) | SAFE |"
    result "| AB-07 | Override before delay | cargo test (LiteSVM) | SAFE |"
    result "| AB-08 | Re-settle | cargo test (LiteSVM) | SAFE |"
    result "| AB-09 | Book manipulation | cargo test (LiteSVM) | SAFE |"
    result "| AB-10 | Dust orders | cargo test (LiteSVM) | SAFE |"
    result "| AB-11 | Trade after close/pause | cargo test (LiteSVM) | SAFE |"
    result "| AB-12 | Integer overflow | cargo test (LiteSVM) | SAFE |"
    result "| AB-13 | Oracle spread > 5 bps | cargo test (LiteSVM) | SAFE |"
    result "| AB-22 | Local-oracle in devnet | cargo test (LiteSVM) | SAFE |"
    ((PASS_COUNT += 9))
else
    log "FAIL: LiteSVM program tests"
    result "| AB-06..13,22 | Various program attacks | cargo test (LiteSVM) | FAIL |"
    ((FAIL_COUNT += 9))
fi

# Off-chain service ABs (no validator needed)
log ""
log "Running off-chain attack tests..."

run_ab_test "18" "Invalid trade intents" "tests/security/ts/ab_18_intents.test.ts"
run_ab_test "21" "Faucet abuse" "tests/security/ts/ab_21_faucet.test.ts"

# AB-14, AB-15, AB-20: Python (ops-agent)
log ""
log "Running ops-agent attack tests..."
if pytest services/ops-agent/tests/security/ -v >> "$LOG_FILE" 2>&1; then
    log "PASS: AB-14, AB-15, AB-20 (ops-agent)"
    result "| AB-14 | Prompt injection | pytest (ops-agent) | SAFE |"
    result "| AB-15 | Draft param bypass | pytest (ops-agent) | SAFE |"
    result "| AB-20 | Jailbreak attempts | pytest (ops-agent) | SAFE |"
    ((PASS_COUNT += 3))
else
    log "FAIL: ops-agent security tests"
    result "| AB-14,15,20 | Agent attacks | pytest (ops-agent) | FAIL |"
    ((FAIL_COUNT += 3))
fi

# AB-16, AB-17, AB-19: Static analysis (no validator)
run_ab_test "16" "Unlocked dependencies" "tests/security/ts/ab_16_locked_dependencies.test.ts"
run_ab_test "17" "Committed secrets" "tests/security/ts/ab_17_no_committed_secrets.test.ts"
run_ab_test "19" "Automation key exposure" "tests/security/ts/ab_19_automation_key.test.ts"

# Summary
log ""
log "=== Attack Run Complete ==="
log "Pass: $PASS_COUNT"
log "Fail: $FAIL_COUNT"
log "Full log: $LOG_FILE"
log "Summary: $SUMMARY_FILE"

result ""
result "**Total: $PASS_COUNT passed, $FAIL_COUNT failed**"

if [ "$FAIL_COUNT" -gt 0 ]; then
    log "ERROR: Some attacks succeeded or tests failed"
    exit 1
fi

log "All attacks rejected as expected"
exit 0
