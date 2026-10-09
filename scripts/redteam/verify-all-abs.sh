#!/usr/bin/env bash
# Red-team verification: test AB-01 through AB-22 against local validator
# Usage: flock /tmp/box-heavy.lock scripts/redteam/verify-all-abs.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LOG_FILE="/tmp/redteam-abs-$(date +%Y%m%d-%H%M%S).log"
RESULTS_FILE="/tmp/redteam-results-$(date +%Y%m%d-%H%M%S).txt"

log() { printf '[redteam] %s\n' "$*" | tee -a "$LOG_FILE"; }
result() { printf '%s\n' "$*" | tee -a "$RESULTS_FILE"; }

log "Starting red-team verification of AB-01 through AB-22"
log "Log: $LOG_FILE"
log "Results: $RESULTS_FILE"

result "# Red-Team Verification Results"
result ""
result "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
result "Program: target/deploy/meridian.so"
result ""
result "| AB ID | Attack Vector | Tool/Command | Outcome | Notes |"
result "|-------|---------------|--------------|---------|-------|"

# AB-01: Minting without equal USDC
log "Testing AB-01: Mint-pair without equal USDC"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_01_minting >> "$LOG_FILE" 2>&1; then
    result "| AB-01 | Mint without equal USDC | \`cargo test ab_01_minting\` | SAFE | Program rejects mismatched USDC transfers |"
    log "AB-01: PASS (program correctly rejects)"
else
    result "| AB-01 | Mint without equal USDC | \`cargo test ab_01_minting\` | FINDING | Test failed - investigation needed |"
    log "AB-01: FAIL"
fi

# AB-02: Redeem mismatched pairs
log "Testing AB-02: Redeem with mismatched YES/NO"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_02_redeem >> "$LOG_FILE" 2>&1; then
    result "| AB-02 | Redeem mismatched YES/NO | \`cargo test ab_02_redeem\` | SAFE | Program enforces 1:1 redemption |"
    log "AB-02: PASS"
else
    result "| AB-02 | Redeem mismatched YES/NO | \`cargo test ab_02_redeem\` | FINDING | Test failed |"
    log "AB-02: FAIL"
fi

# AB-03: Stale oracle data
log "Testing AB-03: Settlement with stale oracle data"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_03_ab_05_timing >> "$LOG_FILE" 2>&1; then
    result "| AB-03/05 | Stale/future oracle, early settle | \`cargo test ab_03_ab_05_timing\` | SAFE | Timestamp validation works |"
    log "AB-03/05: PASS"
else
    result "| AB-03/05 | Stale/future oracle, early settle | \`cargo test ab_03_ab_05_timing\` | FINDING | Test failed |"
    log "AB-03/05: FAIL"
fi

# AB-04: Spoofed oracle accounts
log "Testing AB-04: Spoofed oracle feeds"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_04_oracle_spoof >> "$LOG_FILE" 2>&1; then
    result "| AB-04 | Spoofed oracle accounts | \`cargo test ab_04_oracle_spoof\` | SAFE | Feed ownership/hash validation works |"
    log "AB-04: PASS"
else
    result "| AB-04 | Spoofed oracle accounts | \`cargo test ab_04_oracle_spoof\` | FINDING | Test failed |"
    log "AB-04: FAIL"
fi

# AB-06: Non-admin calling admin functions
log "Testing AB-06: Non-admin access"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_06_admin_only >> "$LOG_FILE" 2>&1; then
    result "| AB-06 | Non-admin calls admin functions | \`cargo test ab_06_admin_only\` | SAFE | Admin-only guards work |"
    log "AB-06: PASS"
else
    result "| AB-06 | Non-admin calls admin functions | \`cargo test ab_06_admin_only\` | FINDING | Test failed |"
    log "AB-06: FAIL"
fi

# AB-07/08: Override delay bypass
log "Testing AB-07/08: Settlement override timing"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_07_ab_08_override >> "$LOG_FILE" 2>&1; then
    result "| AB-07/08 | Override delay bypass | \`cargo test ab_07_ab_08_override\` | SAFE | 60s delay enforced |"
    log "AB-07/08: PASS"
else
    result "| AB-07/08 | Override delay bypass | \`cargo test ab_07_ab_08_override\` | FINDING | Test failed |"
    log "AB-07/08: FAIL"
fi

# AB-09/10: Order book invariants
log "Testing AB-09/10: Book manipulation"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_09_ab_10_book >> "$LOG_FILE" 2>&1 && \
   cargo test --manifest-path programs/meridian/Cargo.toml --test ab_09_orders >> "$LOG_FILE" 2>&1; then
    result "| AB-09/10 | Book/order invariant violations | \`cargo test ab_09_*\` | SAFE | Price/quantity validation works |"
    log "AB-09/10: PASS"
else
    result "| AB-09/10 | Book/order invariant violations | \`cargo test ab_09_*\` | FINDING | Test failed |"
    log "AB-09/10: FAIL"
fi

# AB-11: Trading during close/pause
log "Testing AB-11: Trade during close/pause"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_11_close_pause >> "$LOG_FILE" 2>&1; then
    result "| AB-11 | Trading when closed/paused | \`cargo test ab_11_close_pause\` | SAFE | Status gates work |"
    log "AB-11: PASS"
else
    result "| AB-11 | Trading when closed/paused | \`cargo test ab_11_close_pause\` | FINDING | Test failed |"
    log "AB-11: FAIL"
fi

# AB-12: Integer overflow
log "Testing AB-12: Overflow attacks"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_12_overflow >> "$LOG_FILE" 2>&1; then
    result "| AB-12 | Integer overflow | \`cargo test ab_12_overflow\` | SAFE | Checked math works |"
    log "AB-12: PASS"
else
    result "| AB-12 | Integer overflow | \`cargo test ab_12_overflow\` | FINDING | Test failed |"
    log "AB-12: FAIL"
fi

# AB-13: Oracle spread manipulation
log "Testing AB-13: Wide oracle spread"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_13_oracle_spread >> "$LOG_FILE" 2>&1; then
    result "| AB-13 | Oracle spread > 5 bps | \`cargo test ab_13_oracle_spread\` | SAFE | Spread validation works |"
    log "AB-13: PASS"
else
    result "| AB-13 | Oracle spread > 5 bps | \`cargo test ab_13_oracle_spread\` | FINDING | Test failed |"
    log "AB-13: FAIL"
fi

# AB-14/15/20: Python service attacks (injection, range, jailbreak)
log "Testing AB-14/15/20: Ops-agent attacks"
if uv run --manifest-path services/ops-agent/pyproject.toml pytest services/ops-agent/tests/ -k "ab_14 or ab_15 or ab_20" >> "$LOG_FILE" 2>&1; then
    result "| AB-14/15/20 | Prompt injection, range, jailbreak | \`pytest ab_14/15/20\` | SAFE | Input validation works |"
    log "AB-14/15/20: PASS"
else
    result "| AB-14/15/20 | Prompt injection, range, jailbreak | \`pytest ab_14/15/20\` | FINDING | Test failed |"
    log "AB-14/15/20: FAIL"
fi

# AB-16: Dependency vulnerabilities
log "Testing AB-16: Locked dependencies audit"
if pnpm --dir . test ab_16 >> "$LOG_FILE" 2>&1; then
    result "| AB-16 | Unlocked/vulnerable deps | \`pnpm test ab_16\` | SAFE | Lockfiles enforced |"
    log "AB-16: PASS"
else
    result "| AB-16 | Unlocked/vulnerable deps | \`pnpm test ab_16\` | FINDING | Test failed |"
    log "AB-16: FAIL"
fi

# AB-17: Committed secrets
log "Testing AB-17: Secrets in repo"
if pnpm --dir . test ab_17 >> "$LOG_FILE" 2>&1; then
    result "| AB-17 | Committed secrets/keys | \`pnpm test ab_17\` | SAFE | No secrets found |"
    log "AB-17: PASS"
else
    result "| AB-17 | Committed secrets/keys | \`pnpm test ab_17\` | FINDING | Test failed |"
    log "AB-17: FAIL"
fi

# AB-18: Invalid trade intents
log "Testing AB-18: Malformed trade intents"
if pnpm --dir . test ab_18 >> "$LOG_FILE" 2>&1; then
    result "| AB-18 | Invalid trade intent params | \`pnpm test ab_18\` | SAFE | Intent validation works |"
    log "AB-18: PASS"
else
    result "| AB-18 | Invalid trade intent params | \`pnpm test ab_18\` | FINDING | Test failed |"
    log "AB-18: FAIL"
fi

# AB-19: Automation key exposure
log "Testing AB-19: Exposed automation keys"
if pnpm --dir . test ab_19 >> "$LOG_FILE" 2>&1; then
    result "| AB-19 | Automation key in client | \`pnpm test ab_19\` | SAFE | Keys stay server-side |"
    log "AB-19: PASS"
else
    result "| AB-19 | Automation key in client | \`pnpm test ab_19\` | FINDING | Test failed |"
    log "AB-19: FAIL"
fi

# AB-21: Faucet abuse
log "Testing AB-21: Faucet limit bypass"
if pnpm --dir . test ab_21 >> "$LOG_FILE" 2>&1; then
    result "| AB-21 | Faucet rate limit bypass | \`pnpm test ab_21\` | SAFE | 24h limit enforced |"
    log "AB-21: PASS"
else
    result "| AB-21 | Faucet rate limit bypass | \`pnpm test ab_21\` | FINDING | Test failed |"
    log "AB-21: FAIL"
fi

# AB-22: Local oracle in devnet build
log "Testing AB-22: Devnet build oracle feature"
if cargo test --manifest-path programs/meridian/Cargo.toml --test ab_22_local_oracle_feature >> "$LOG_FILE" 2>&1 && \
   cargo test --manifest-path programs/meridian/Cargo.toml --test ab_22_devnet_build --include-ignored >> "$LOG_FILE" 2>&1; then
    result "| AB-22 | local-oracle in devnet | \`cargo test ab_22_*\` | SAFE | Feature flag isolation works |"
    log "AB-22: PASS"
else
    result "| AB-22 | local-oracle in devnet | \`cargo test ab_22_*\` | FINDING | Test failed |"
    log "AB-22: FAIL"
fi

log "Red-team verification complete"
log "Full log: $LOG_FILE"
log "Results table: $RESULTS_FILE"

cat "$RESULTS_FILE"
