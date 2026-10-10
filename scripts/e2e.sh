#!/usr/bin/env bash
# End-to-end smoke on a local validator (`make e2e`).
#
# Deploys the local build under a throwaway program ID, then runs the lifecycle smoke
# (tests/e2e/src/lifecycle.ts): config with local feeds, create-markets twice, the four trade
# intents, settlement with the local oracle, settle_funds and redeem, with the invariants
# asserted after every step and exact P&L. The market closes a few seconds after creation
# (E2E_CLOSE_IN_SECS), so no clock warp is needed.
#
# `scripts/e2e.sh --dev` (make dev) stops after seeding the config and markets and then runs the
# app until interrupted; the validator stays up on :8899.
#
# `scripts/e2e.sh --pyth` runs tests/e2e/src/pyth-settle.ts instead of the lifecycle: Pyth Lazer
# settlement from a real signed update. It calls the live Pyth API with PYTH_API_TOKEN from the
# repo-root .env, so it is a manual check and not part of `make e2e`.
#
# Environment (all optional):
#   E2E_PAYER_KEYPAIR  existing payer keypair file; a throwaway one is created when unset/missing
#   E2E_RPC_PORT       validator RPC port (default 8899; the websocket port is this plus one)
#   E2E_FAUCET_PORT    validator faucet port (default 9900)
#   E2E_CLOSE_IN_SECS  seconds between market creation and close (default 150)
#   E2E_PREBUILT       1 (CI): load the existing target/deploy/meridian.so (built with the program ID
#                      declared in Anchor.toml) into the validator at genesis, instead of keys sync +
#                      build + deploy, so the job compiles nothing. Unset: build and deploy as before.
set -euo pipefail

MODE="e2e"
if [ "${1:-}" = "--dev" ]; then
  MODE="dev"
elif [ "${1:-}" = "--pyth" ]; then
  MODE="pyth"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

readonly PROGRAM_SRC="programs/meridian/src/lib.rs"
readonly ANCHOR_TOML="Anchor.toml"
readonly PROGRAM_KEYPAIR="target/deploy/meridian-keypair.json"
readonly PROGRAM_SO="target/deploy/meridian.so"
readonly PROGRAM_IDL="target/idl/meridian.json"
PREBUILT="${E2E_PREBUILT:-0}"
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
# Prebuilt mode never rewrites them.
if [ "$PREBUILT" != "1" ]; then
  git diff --quiet HEAD -- "$PROGRAM_SRC" "$ANCHOR_TOML" ||
    die "$PROGRAM_SRC or $ANCHOR_TOML has uncommitted changes; commit them before running make e2e"
fi

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
  if [ "$PREBUILT" != "1" ]; then
    git checkout -- "$PROGRAM_SRC" "$ANCHOR_TOML"
    rm -f "$PROGRAM_KEYPAIR"
  fi
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

# Build before starting the validator (~1.4 GB RSS), so the two never hold memory at once.
# Prebuilt mode skips keys sync + build and loads the .so at genesis instead.
VALIDATOR_ARGS=()
if [ "$PREBUILT" = "1" ]; then
  [ -f "$PROGRAM_SO" ] && [ -f "$PROGRAM_IDL" ] ||
    die "E2E_PREBUILT=1 needs $PROGRAM_SO and $PROGRAM_IDL (the CI build job's artifacts)"
  PROGRAM_ID="$(sed -n 's/^meridian = "\(.*\)"$/\1/p' "$ANCHOR_TOML" | head -n 1)"
  [ -n "$PROGRAM_ID" ] || die "no meridian program ID in $ANCHOR_TOML"
  VALIDATOR_ARGS=(--bpf-program "$PROGRAM_ID" "$PROGRAM_SO")
else
  mkdir -p "$(dirname "$PROGRAM_KEYPAIR")"
  solana-keygen new --no-bip39-passphrase -s --force -o "$PROGRAM_KEYPAIR"
  anchor keys sync
  log "throwaway program ID $(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
  make build-local
fi

log "starting solana-test-validator on $RPC_URL"
solana-test-validator --reset --quiet --ledger "$WORK/ledger" "${VALIDATOR_ARGS[@]}" \
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

if [ "$PREBUILT" = "1" ]; then
  log "prebuilt program $PROGRAM_ID loaded at genesis from $PROGRAM_SO"
else
  anchor deploy --provider.cluster "$RPC_URL" --provider.wallet "$PAYER"
  PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
fi

export ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$PAYER" E2E_PROGRAM_ID="$PROGRAM_ID" SOLANA_CLUSTER=localnet

if [ "$MODE" = "dev" ]; then
  # Seed: config with local feeds and a day's markets that stay open for 8 hours. The seed
  # prints SEED_USDC_MINT=<mint>; the app needs it with the throwaway program ID and the RPC URL.
  E2E_SEED_ONLY=1 E2E_CLOSE_IN_SECS=28800 pnpm --filter e2e run lifecycle | tee "$WORK/seed.log"
  USDC_MINT="$(sed -n 's/^SEED_USDC_MINT=//p' "$WORK/seed.log" | tail -n 1)"
  [ -n "$USDC_MINT" ] || die "the seed did not report the USDC mint"
  export NEXT_PUBLIC_CLUSTER=localnet NEXT_PUBLIC_RPC_URL="$RPC_URL"
  export NEXT_PUBLIC_PROGRAM_ID="$PROGRAM_ID" NEXT_PUBLIC_USDC_MINT="$USDC_MINT"
  log "validator $RPC_URL, program $PROGRAM_ID, USDC mint $USDC_MINT"
  log "starting the app on http://localhost:3000 (Ctrl-C stops the app and the validator)"
  pnpm --filter app dev
  exit 0
fi

if [ "$MODE" = "pyth" ]; then
  pnpm --filter e2e run pyth-settle
  log "PASS"
  exit 0
fi

pnpm --filter e2e run lifecycle
# The on-chain halves of AB-01 through AB-05 need this validator and the initialised config
# the lifecycle left behind; outside `make e2e` they are skipped.
# Serially (--no-file-parallelism): ab_03 and ab_04 both rewrite the shared META LocalFeed PDAs.
E2E_REQUIRE_VALIDATOR=1 pnpm --filter security-tests-ts exec vitest run --no-file-parallelism \
  ab_01_mint_without_deposit ab_02_redeem_attacks \
  ab_03_stale_or_wrong_date ab_04_spoofed_feed ab_05_settle_before_close
log "PASS"
