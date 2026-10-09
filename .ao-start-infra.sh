#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export E2E_PAYER_KEYPAIR="/tmp/ao-e2e-payer.json"
export E2E_CLOSE_IN_SECS=28800
trap 'kill 0' EXIT
# Let e2e.sh do the heavy lifting in dev mode, capture env vars
scripts/e2e.sh --dev 2>&1 | tee .ao-dev.log &
wait
