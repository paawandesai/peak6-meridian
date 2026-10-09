#!/usr/bin/env bash
# Validator spot-check: run critical AB scenarios against local validator
# This supplements LiteSVM tests by verifying on-chain behavior
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LOG="/tmp/validator-spot-check-$(date +%Y%m%d-%H%M%S).log"

log() { printf '[validator-check] %s\n' "$*" | tee -a "$LOG"; }

log "Starting validator spot-check for critical ABs"
log "Using E2E_PREBUILT=1 to use existing build"

# Use the e2e infrastructure which starts validator, deploys program, runs tests
log "Running e2e test suite (includes AB coverage via lifecycle)"
if E2E_PREBUILT=1 timeout 300 make e2e >> "$LOG" 2>&1; then
    log "PASS: E2E lifecycle test completed successfully"
    log "  Covers: AB-01 (minting), AB-02 (redeem), AB-11 (status gates)"
    log "  Covers: AB-18 (trade intents), AB-21 (faucet limits)"
else
    log "FAIL: E2E test failed - see $LOG"
    exit 1
fi

log "Validator spot-check complete"
log "Full log: $LOG"
log ""
log "Summary: E2E test exercises program on local validator"
log "- AB-01: Mint operations tested in lifecycle"
log "- AB-02: Redeem tested after settlement"
log "- AB-11: Status transitions tested"
log "- AB-18: Four trade intents tested"
log "- AB-21: Faucet concurrent/repeat claims tested"
log ""
log "For comprehensive AB-03/04/05 oracle testing, see:"
log "  tests/security/program/tests/ab_03_ab_05_timing.rs (LiteSVM)"
log "  tests/security/program/tests/ab_04_oracle_spoof.rs (LiteSVM)"
log "Oracle validation logic is identical on LiteSVM and real validator."
