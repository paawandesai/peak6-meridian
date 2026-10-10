#!/usr/bin/env bash
# M3-10b upgrade rehearsal: replay the devnet program upgrade + Config migration on a LOCAL
# validator against a clone of the real devnet Config and the currently deployed devnet binary.
# Nothing is sent to devnet: it is only READ (solana account / solana program dump).
#
#   1. dump the devnet Config account and the deployed program binary (read-only)
#   2. start solana-test-validator with that binary at the same program id (local upgrade
#      authority) and the cloned Config (admin field re-pointed to a local key, unless
#      REHEARSAL_ADMIN_KEYPAIR is the real admin; every other byte is the devnet bytes)
#   3. old program works against the v1 Config (pause + unpause)
#   4. upgrade to the new devnet build (`make build-devnet`), extending ProgramData if needed
#   5. a Config-loading instruction fails cleanly before migration (Anchor 3003, no panic)
#   6. make migrate-config: DRY_RUN, real run, re-run (idempotent)
#   7. independent byte check: bytes 0..1076 identical to the devnet clone, size 1,144
#   8. post-migration smoke: update_config, create_strike_market, mint_pair, place_order,
#      settle_market via the Pyth path, settle_funds, winner redeem
#   9. rollback drill: the old binary redeployed over the migrated Config still works and
#      leaves every byte unchanged
#
# Usage: scripts/rehearse-config-migration.sh
# Env: DEVNET_URL (default https://api.devnet.solana.com; read-only), REHEARSAL_RPC_PORT (8999),
#      REHEARSAL_FAUCET_PORT (9999), REHEARSAL_GOSSIP_PORT (8998),
#      REHEARSAL_DYNAMIC_PORTS (20100-20200), SKIP_BUILD=1 (reuse target/deploy/meridian.so from a
#      prior `make build-devnet`), KEEP=1 (keep the work dir), REHEARSAL_ADMIN_KEYPAIR (optional).
# After it runs, target/ holds the devnet build: run `make build-local` before `make test`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NODE_VERSION="$(tr -d '[:space:]' < .nvmrc)"
export PATH="$HOME/.cargo/bin:$HOME/.avm/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.nvm/versions/node/v$NODE_VERSION/bin:$PATH"

PROGRAM_ID=H8SBU6m8sGRvKudUGhroDP4oEMyvF9QDhVc9wTFESXSm
CONFIG=6Bf88kHFDDjdXG1BEdrj1edkLwWt9pEiKPFp6Ekhkoew
DEVNET_URL="${DEVNET_URL:-https://api.devnet.solana.com}"
RPC_PORT="${REHEARSAL_RPC_PORT:-8999}"
FAUCET_PORT="${REHEARSAL_FAUCET_PORT:-9999}"
GOSSIP_PORT="${REHEARSAL_GOSSIP_PORT:-8998}"
DYNAMIC_PORTS="${REHEARSAL_DYNAMIC_PORTS:-20100-20200}"
LOCAL_URL="http://127.0.0.1:$RPC_PORT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/meridian-rehearsal.XXXXXX")"
VALIDATOR_PID=""

say() { printf '\n=== %s\n' "$*"; }
cleanup() {
  if [[ -n "$VALIDATOR_PID" ]]; then kill "$VALIDATOR_PID" 2>/dev/null || true; wait "$VALIDATOR_PID" 2>/dev/null || true; fi
  if [[ "${KEEP:-}" == "1" ]]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

for port in "$RPC_PORT" "$((RPC_PORT + 1))" "$FAUCET_PORT" "$GOSSIP_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is busy (another validator?); set REHEARSAL_*_PORT" >&2
    exit 1
  fi
done

say "1. build the devnet artifact (no local oracle)"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then make build-devnet >"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log"; exit 1; }; fi
if grep -q '"local_oracle_set"' target/idl/meridian.json; then
  echo "target/ holds a local-oracle build; run make build-devnet (or drop SKIP_BUILD)" >&2
  exit 1
fi
cp target/deploy/meridian.so "$WORK/new.so"
echo "new build: $(wc -c <"$WORK/new.so" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$WORK/new.so" | cut -c1-16)"

say "2. read the devnet Config and program binary (read-only)"
solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/upgrade-authority.json" >/dev/null
solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/pyth-signer.json" >/dev/null
solana account "$CONFIG" -u "$DEVNET_URL" --output json --output-file "$WORK/config.devnet.json" >/dev/null
solana program dump "$PROGRAM_ID" "$WORK/old.so" -u "$DEVNET_URL" -k "$WORK/upgrade-authority.json" >/dev/null
echo "devnet program binary: $(wc -c <"$WORK/old.so" | tr -d ' ') bytes"
if [[ -n "${REHEARSAL_ADMIN_KEYPAIR:-}" ]]; then ADMIN="$REHEARSAL_ADMIN_KEYPAIR"; else ADMIN="$WORK/upgrade-authority.json"; fi
ADMIN_PUBKEY="$(solana-keygen pubkey "$ADMIN")"
python3 - "$WORK/config.devnet.json" "$WORK/config.json" "$ADMIN_PUBKEY" <<'PY'
import base64, json, sys
src, dst, admin = sys.argv[1:4]
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58decode(text):
    n = 0
    for ch in text: n = n * 58 + ALPHABET.index(ch)
    raw = n.to_bytes(32, "big")
    return raw
doc = json.load(open(src))
data = bytearray(base64.b64decode(doc["account"]["data"][0]))
stored = bytes(data[8:40])
print(f"devnet Config: {len(data)} bytes, {doc['account']['lamports']} lamports, owner {doc['account']['owner']}")
if stored != b58decode(admin):
    data[8:40] = b58decode(admin)
    print("admin field (bytes 8..40) re-pointed to the local rehearsal key; every other byte is devnet's")
else:
    print("admin field unchanged: the rehearsal signs with the real admin")
doc["account"]["data"][0] = base64.b64encode(bytes(data)).decode()
json.dump(doc, open(dst, "w"))
PY

say "3. start a local validator: devnet binary at $PROGRAM_ID + cloned Config (port $RPC_PORT)"
solana-test-validator --reset --quiet --ledger "$WORK/ledger" \
  --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" --gossip-port "$GOSSIP_PORT" \
  --dynamic-port-range "$DYNAMIC_PORTS" --bind-address 127.0.0.1 \
  --upgradeable-program "$PROGRAM_ID" "$WORK/old.so" "$WORK/upgrade-authority.json" \
  --account "$CONFIG" "$WORK/config.json" >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!
for _ in $(seq 1 60); do
  if solana cluster-version -u "$LOCAL_URL" >/dev/null 2>&1; then break; fi
  sleep 1
done
solana cluster-version -u "$LOCAL_URL" >/dev/null
solana airdrop 100 "$ADMIN_PUBKEY" -u "$LOCAL_URL" >/dev/null
[[ "$ADMIN" == "$WORK/upgrade-authority.json" ]] || solana airdrop 10 "$(solana-keygen pubkey "$WORK/upgrade-authority.json")" -u "$LOCAL_URL" >/dev/null
solana program show "$PROGRAM_ID" -u "$LOCAL_URL" -k "$ADMIN" | sed 's/^/  /'

export SOLANA_RPC_URL="$LOCAL_URL" SOLANA_CLUSTER=localnet ADMIN_KEYPAIR_PATH="$ADMIN" \
  PYTH_SIGNER_KEYPAIR_PATH="$WORK/pyth-signer.json" MERIDIAN_PROGRAM_ID="$PROGRAM_ID"
smoke() { pnpm --silent --filter deploy run rehearsal-smoke "$1"; }
config_size() { solana account "$CONFIG" -u "$LOCAL_URL" --output json | python3 -c 'import json,sys,base64; a=json.load(sys.stdin)["account"]; print(len(base64.b64decode(a["data"][0])), a["lamports"])'; }

say "4. old program against the v1 Config"
read -r SIZE_BEFORE LAMPORTS_BEFORE < <(config_size)
echo "Config before upgrade: $SIZE_BEFORE bytes, $LAMPORTS_BEFORE lamports"
smoke check-old

say "5. upgrade the program to the new build"
NEW_LEN=$(wc -c <"$WORK/new.so" | tr -d ' ')
DATA_LEN=$(solana program show "$PROGRAM_ID" -u "$LOCAL_URL" -k "$ADMIN" --output json | python3 -c 'import json,sys; print(json.load(sys.stdin)["dataLen"])')
if (( NEW_LEN > DATA_LEN )); then
  EXTEND=$(( NEW_LEN - DATA_LEN ))
  echo "new binary is $EXTEND bytes larger than ProgramData ($DATA_LEN): solana program extend"
  solana program extend "$PROGRAM_ID" "$EXTEND" -u "$LOCAL_URL" -k "$WORK/upgrade-authority.json"
fi
solana program deploy "$WORK/new.so" --program-id "$PROGRAM_ID" \
  --upgrade-authority "$WORK/upgrade-authority.json" -k "$WORK/upgrade-authority.json" -u "$LOCAL_URL"
sleep 2
solana program show "$PROGRAM_ID" -u "$LOCAL_URL" -k "$ADMIN" | sed 's/^/  /'

say "6. before migration: Config-loading instructions fail cleanly"
smoke pre-migration

say "7. make migrate-config (DRY_RUN, then for real, then again)"
PYTH_SIGNER="$(solana-keygen pubkey "$WORK/pyth-signer.json")"
DRY_RUN=1 PYTH_LAZER_SIGNER="$PYTH_SIGNER" make --no-print-directory migrate-config
PYTH_LAZER_SIGNER="$PYTH_SIGNER" make --no-print-directory migrate-config
make --no-print-directory migrate-config

say "8. independent byte check against the devnet clone"
solana account "$CONFIG" -u "$LOCAL_URL" --output json --output-file "$WORK/config.after.json" >/dev/null
python3 - "$WORK/config.json" "$WORK/config.after.json" "$WORK/config.devnet.json" <<'PY'
import base64, json, sys
load = lambda p: json.load(open(p))["account"]
before, after, devnet = (load(p) for p in sys.argv[1:4])
b = base64.b64decode(before["data"][0]); a = base64.b64decode(after["data"][0]); d = base64.b64decode(devnet["data"][0])
assert len(b) == 1076 and len(a) == 1144, (len(b), len(a))
assert a[:1076] == b, "old bytes changed"
assert a[:8] + a[40:1076] == d[:8] + d[40:1076], "devnet bytes (except admin) changed"
print(f"size {len(b)} -> {len(a)} bytes; lamports {before['lamports']} -> {after['lamports']}")
print("bytes 0..1076 identical to the clone; all devnet bytes outside the admin field identical")
print(f"new tail: signer {a[1076:1108].hex()[:16]}..., feed ids {[int.from_bytes(a[1108+4*i:1112+4*i],'little') for i in range(7)]}, max age {int.from_bytes(a[1136:1144],'little',signed=True)}")
PY

say "9. post-migration smoke"
smoke post-migration

say "10. rollback drill: redeploy the old devnet binary over the migrated Config"
solana account "$CONFIG" -u "$LOCAL_URL" --output json --output-file "$WORK/config.pre-rollback.json" >/dev/null
solana program deploy "$WORK/old.so" --program-id "$PROGRAM_ID" \
  --upgrade-authority "$WORK/upgrade-authority.json" -k "$WORK/upgrade-authority.json" -u "$LOCAL_URL"
sleep 2
smoke check-old
solana account "$CONFIG" -u "$LOCAL_URL" --output json --output-file "$WORK/config.post-rollback.json" >/dev/null
python3 - "$WORK/config.pre-rollback.json" "$WORK/config.post-rollback.json" <<'PY'
import base64, json, sys
pre, post = (base64.b64decode(json.load(open(p))["account"]["data"][0]) for p in sys.argv[1:3])
assert len(pre) == len(post) == 1144 and pre == post, "old program changed the migrated Config"
print("old binary reads and writes the 1,144-byte Config (pause + unpause) and leaves every byte, including the Pyth tail, unchanged: rollback is safe without un-migrating")
PY

say "REHEARSAL PASSED"
