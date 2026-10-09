#!/usr/bin/env bash
# Background infrastructure: validator + seed + app (for M2-06 evidence generation)
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
trap 'kill 0' EXIT

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

WORK="$(mktemp -d)"
RPC_PORT=8899
FAUCET_PORT=9900
RPC_URL="http://127.0.0.1:$RPC_PORT"

log() { printf '[infra] %s\n' "$*" >&2; }
die() { printf '[infra] ERROR: %s\n' "$*" >&2; exit 1; }

# Check nothing on port
if solana cluster-version --url "$RPC_URL" > /dev/null 2>&1; then
  die "something already on $RPC_URL"
fi

# Throwaway keys
PAYER="$WORK/payer.json"
PROGRAM_KEYPAIR="target/deploy/meridian-keypair.json"
solana-keygen new --no-bip39-passphrase -s -o "$PAYER" >/dev/null 2>&1
mkdir -p "$(dirname "$PROGRAM_KEYPAIR")"
solana-keygen new --no-bip39-passphrase -s --force -o "$PROGRAM_KEYPAIR" >/dev/null 2>&1
log "payer $(solana-keygen pubkey "$PAYER"), program $(solana-keygen pubkey "$PROGRAM_KEYPAIR")"

# Sync keys and build
anchor keys sync
make build-local >/dev/null 2>&1

# Start validator
log "starting validator on $RPC_URL"
solana-test-validator --reset --quiet --ledger "$WORK/ledger" \
  --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!

for _ in $(seq 1 120); do
  if solana cluster-version --url "$RPC_URL" >/dev/null 2>&1; then
    break
  fi
  kill -0 "$VALIDATOR_PID" 2>/dev/null || die "validator exited during startup"
  sleep 1
done
solana cluster-version --url "$RPC_URL" >/dev/null 2>&1 || die "validator not ready after 120s"

solana airdrop 100 --url "$RPC_URL" --keypair "$PAYER" >/dev/null
log "airdropped 100 SOL"

# Deploy
anchor deploy --provider.cluster "$RPC_URL" --provider.wallet "$PAYER" >/dev/null 2>&1
PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"

export ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$PAYER" E2E_PROGRAM_ID="$PROGRAM_ID"

# Seed
log "seeding config and markets"
E2E_SEED_ONLY=1 E2E_CLOSE_IN_SECS=28800 pnpm --filter e2e run lifecycle 2>&1 | tee "$WORK/seed.log" >/dev/null
USDC_MINT="$(sed -n 's/^SEED_USDC_MINT=//p' "$WORK/seed.log" | tail -n 1)"
[ -n "$USDC_MINT" ] || die "no USDC mint from seed"

export NEXT_PUBLIC_CLUSTER=localnet NEXT_PUBLIC_RPC_URL="$RPC_URL"
export NEXT_PUBLIC_PROGRAM_ID="$PROGRAM_ID" NEXT_PUBLIC_USDC_MINT="$USDC_MINT"

log "building app"
cd app
pnpm build >/dev/null 2>&1

log "starting app on :3000"
pnpm start &
APP_PID=$!

# Wait for app
for _ in $(seq 1 60); do
  if curl -sf http://localhost:3000/ >/dev/null 2>&1; then
    log "app ready"
    break
  fi
  sleep 1
done

log "READY: validator $RPC_URL, program $PROGRAM_ID, USDC $USDC_MINT, app http://localhost:3000"
echo "INFRA_RPC_URL=$RPC_URL"
echo "INFRA_PROGRAM_ID=$PROGRAM_ID"
echo "INFRA_USDC_MINT=$USDC_MINT"

wait
