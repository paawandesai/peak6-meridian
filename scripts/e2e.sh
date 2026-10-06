#!/usr/bin/env bash
# End-to-end smoke on a local validator (`make e2e`).
#
# M1-01 placeholder (replaced by the full lifecycle in M1-10): deploy the local build under a
# throwaway program ID and call `version`.
#
# Environment (all optional):
#   E2E_PAYER_KEYPAIR  existing payer keypair file; a throwaway one is created when unset/missing
#   E2E_RPC_PORT       validator RPC port (default 8899; the websocket port is this plus one)
#   E2E_FAUCET_PORT    validator faucet port (default 9900)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

readonly PROGRAM_SRC="programs/meridian/src/lib.rs"
readonly ANCHOR_TOML="Anchor.toml"
readonly PROGRAM_KEYPAIR="target/deploy/meridian-keypair.json"
RPC_PORT="${E2E_RPC_PORT:-8899}"
FAUCET_PORT="${E2E_FAUCET_PORT:-9900}"
RPC_URL="http://127.0.0.1:$RPC_PORT"

log() { printf '[e2e] %s\n' "$*"; }
die() {
  printf '[e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

# `anchor keys sync` rewrites the program ID in these two files and the exit trap restores them
# with `git checkout --`; refuse to run if that would discard someone's uncommitted work.
git diff --quiet HEAD -- "$PROGRAM_SRC" "$ANCHOR_TOML" ||
  die "$PROGRAM_SRC or $ANCHOR_TOML has uncommitted changes; commit them before running make e2e"

if solana cluster-version --url "$RPC_URL" > /dev/null 2>&1; then
  die "something is already serving $RPC_URL; stop it or set E2E_RPC_PORT"
fi

WORK="$(mktemp -d)"
VALIDATOR_PID=""

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ -n "$VALIDATOR_PID" ] && kill -0 "$VALIDATOR_PID" 2> /dev/null; then
    kill "$VALIDATOR_PID" 2> /dev/null || true
    wait "$VALIDATOR_PID" 2> /dev/null || true
  fi
  git checkout -- "$PROGRAM_SRC" "$ANCHOR_TOML"
  rm -f "$PROGRAM_KEYPAIR"
  if [ "$rc" -ne 0 ] && [ -f "$WORK/validator.log" ]; then
    log "validator log (last 40 lines):"
    tail -n 40 "$WORK/validator.log" || true
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PAYER="${E2E_PAYER_KEYPAIR:-}"
if [ -z "$PAYER" ] || [ ! -f "$PAYER" ]; then
  PAYER="$WORK/payer.json"
  solana-keygen new --no-bip39-passphrase -s -o "$PAYER"
  log "created throwaway payer $(solana-keygen pubkey "$PAYER")"
fi

log "starting solana-test-validator on $RPC_URL"
solana-test-validator --reset --quiet --ledger "$WORK/ledger" \
  --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" > "$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!

for _ in $(seq 1 120); do
  if solana cluster-version --url "$RPC_URL" > /dev/null 2>&1; then
    break
  fi
  kill -0 "$VALIDATOR_PID" 2> /dev/null || die "solana-test-validator exited during startup"
  sleep 1
done
solana cluster-version --url "$RPC_URL" > /dev/null 2>&1 || die "validator not ready after 120 s"

solana airdrop 100 --url "$RPC_URL" --keypair "$PAYER" > /dev/null
log "airdropped 100 SOL to the payer"

mkdir -p "$(dirname "$PROGRAM_KEYPAIR")"
solana-keygen new --no-bip39-passphrase -s --force -o "$PROGRAM_KEYPAIR"
anchor keys sync
log "throwaway program ID $(solana-keygen pubkey "$PROGRAM_KEYPAIR")"

make build-local
anchor deploy --provider.cluster "$RPC_URL" --provider.wallet "$PAYER"

ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$PAYER" pnpm --filter e2e run version
log "PASS"
