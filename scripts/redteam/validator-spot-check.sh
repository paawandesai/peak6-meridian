#!/usr/bin/env bash
# Validator spot-check: run ATTACK attempts for AB-01..AB-22 against local validator
# M4-04 AC1/AC5: adversarial attempts (not happy-path lifecycle), with E2E_REQUIRE_VALIDATOR=1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LOG="/tmp/validator-spot-check-$(date +%Y%m%d-%H%M%S).log"

log() { printf '[validator-check] %s\n' "$*" | tee -a "$LOG"; }

log "M4-04 Validator Attack Spot-Check"
log "Running adversarial attempts for each on-chain AB with E2E_REQUIRE_VALIDATOR=1"
log ""

# Start validator, deploy program, initialize config
log "Starting local validator and deploying program..."
if ! E2E_PREBUILT=1 timeout 400 scripts/e2e.sh >> "$LOG" 2>&1; then
    log "FAIL: Validator startup failed - see $LOG"
    exit 1
fi

log "Validator ready, running attack tests..."

# Run attack scripts with E2E_REQUIRE_VALIDATOR=1 (mandatory on-chain execution)
export E2E_REQUIRE_VALIDATOR=1
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"

log "Running AB-01: Mint without deposit attacks..."
if pnpm --filter security-tests run vitest run tests/security/ts/ab_01_mint_without_deposit.test.ts >> "$LOG" 2>&1; then
    log "PASS: AB-01 (all mint attacks rejected)"
else
    log "FAIL: AB-01"
    exit 1
fi

log "Running AB-02: Redeem attacks..."
if pnpm --filter security-tests run vitest run tests/security/ts/ab_02_redeem_attacks.test.ts >> "$LOG" 2>&1; then
    log "PASS: AB-02 (all redeem attacks rejected)"
else
    log "FAIL: AB-02"
    exit 1
fi

log "Running AB-03: Stale oracle attacks..."
if pnpm --filter security-tests run vitest run tests/security/ts/ab_03_stale_or_wrong_date.test.ts >> "$LOG" 2>&1; then
    log "PASS: AB-03 (stale/wrong-date rejected)"
else
    log "FAIL: AB-03"
    exit 1
fi

log "Running AB-04: Spoofed oracle attacks..."
if pnpm --filter security-tests run vitest run tests/security/ts/ab_04_spoofed_feed.test.ts >> "$LOG" 2>&1; then
    log "PASS: AB-04 (spoofed feeds rejected)"
else
    log "FAIL: AB-04"
    exit 1
fi

log "Running AB-05: Settle-before-close attacks..."
if pnpm --filter security-tests run vitest run tests/security/ts/ab_05_settle_before_close.test.ts >> "$LOG" 2>&1; then
    log "PASS: AB-05 (early settle rejected)"
else
    log "FAIL: AB-05"
    exit 1
fi

log ""
log "=== Validator Attack Spot-Check Complete ==="
log "All on-chain attacks rejected as expected"
log "Full log: $LOG"
log ""
log "Outcome per AB:"
log "  AB-01 (mint without deposit): SAFE"
log "  AB-02 (redeem attacks): SAFE"
log "  AB-03 (stale oracle): SAFE"
log "  AB-04 (spoofed oracle): SAFE"
log "  AB-05 (settle before close): SAFE"
log ""
log "Note: AB-06..13, AB-22 covered by LiteSVM tests (tests/security/program/)"
log "      AB-14,15,20 covered by ops-agent pytest"
log "      AB-16,17,19 covered by static analysis (lockfiles, gitleaks)"
log "      AB-18,21 covered by vitest (no validator needed)"
