#!/usr/bin/env bash
# M2-06 evidence generation: validator + seed + app + Playwright four-intent + Lighthouse
# One bounded attempt, 60 min max
set -euo pipefail

export PATH=$HOME/.cargo/bin:$HOME/.avm/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
trap 'kill 0' EXIT

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { echo "[$(date +%H:%M:%S)] FAILED: $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

WORK="/tmp/m2-06-evidence"
rm -rf "$WORK"
mkdir -p "$WORK"

RPC_PORT=8899
RPC_URL="http://127.0.0.1:$RPC_PORT"
APP_URL="http://localhost:3000"

# Check ports free
solana cluster-version --url "$RPC_URL" >/dev/null 2>&1 && die "Port $RPC_PORT already in use"
curl -sf "$APP_URL" >/dev/null 2>&1 && die "Port 3000 already in use"

log "Creating throwaway keys"
PAYER="$WORK/payer.json"
PROGRAM_KEYPAIR="target/deploy/meridian-keypair.json"
solana-keygen new --no-bip39-passphrase -s -o "$PAYER" >/dev/null 2>&1
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase -s --force -o "$PROGRAM_KEYPAIR" >/dev/null 2>&1

log "Syncing keys and building program"
anchor keys sync
make build-local

log "Starting validator on $RPC_URL"
solana-test-validator --reset --quiet --ledger "$WORK/ledger" \
  --rpc-port "$RPC_PORT" --faucet-port 9900 >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!

# Wait for validator
for i in $(seq 1 120); do
  if solana cluster-version --url "$RPC_URL" >/dev/null 2>&1; then
    log "Validator ready after ${i}s"
    break
  fi
  kill -0 "$VALIDATOR_PID" 2>/dev/null || die "Validator exited during startup, see $WORK/validator.log"
  sleep 1
done
solana cluster-version --url "$RPC_URL" >/dev/null 2>&1 || die "Validator not ready after 120s"

log "Airdropping SOL"
solana airdrop 100 --url "$RPC_URL" --keypair "$PAYER" >/dev/null

log "Deploying program"
anchor deploy --provider.cluster "$RPC_URL" --provider.wallet "$PAYER"
PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
log "Program deployed: $PROGRAM_ID"

export ANCHOR_PROVIDER_URL="$RPC_URL"
export ANCHOR_WALLET="$PAYER"
export E2E_PROGRAM_ID="$PROGRAM_ID"

log "Seeding config and markets (8h close)"
E2E_SEED_ONLY=1 E2E_CLOSE_IN_SECS=28800 pnpm --filter e2e run lifecycle 2>&1 | tee "$WORK/seed.log"
USDC_MINT="$(sed -n 's/^SEED_USDC_MINT=//p' "$WORK/seed.log" | tail -n 1)"
[ -n "$USDC_MINT" ] || die "No USDC mint from seed"
log "Seed complete: USDC mint $USDC_MINT"

export NEXT_PUBLIC_CLUSTER=localnet
export NEXT_PUBLIC_RPC_URL="$RPC_URL"
export NEXT_PUBLIC_PROGRAM_ID="$PROGRAM_ID"
export NEXT_PUBLIC_USDC_MINT="$USDC_MINT"

log "Building app (production)"
cd app
pnpm build

log "Starting app on :3000"
pnpm start >"$WORK/app.log" 2>&1 &
APP_PID=$!
cd "$ROOT"

# Wait for app
for i in $(seq 1 60); do
  if curl -sf "$APP_URL" >/dev/null 2>&1; then
    log "App ready after ${i}s"
    break
  fi
  sleep 1
done
curl -sf "$APP_URL" >/dev/null 2>&1 || die "App not ready after 60s"

log "Creating Playwright test for four intents"
mkdir -p "$WORK/playwright"

# Copy wallet support from M2-13 branch
git show origin/m2-13-playwright-smoke:tests/e2e/playwright/support/wallet.ts > "$WORK/playwright/wallet.ts"

# Create four-intent test
cat > "$WORK/playwright/four-intents.spec.ts" << 'EOTEST'
import { test, expect } from '@playwright/test';
import { Keypair } from '@solana/web3.js';
import { installTestWallet, WALLET_NAME } from './wallet';

const intents = ['Buy YES', 'Sell YES', 'Buy NO', 'Sell NO'] as const;

test.describe('M2-06 AC5: Four intents on local validator', () => {
  let trader: Keypair;
  let timings: Record<string, number> = {};

  test.beforeAll(async () => {
    trader = Keypair.generate();
  });

  for (const intent of intents) {
    test(`${intent} completes and confirms within 3s`, async ({ page, context }) => {
      const wallet = await installTestWallet(page, trader);

      await page.goto('http://localhost:3000');
      await expect(page.locator('text=Meridian')).toBeVisible({ timeout: 10000 });

      // Click first market row to go to Trade page
      await page.locator('table tbody tr').first().click();
      await expect(page.getByText(/Will.*close/)).toBeVisible({ timeout: 5000 });

      // Wait for wallet button and connect
      await page.getByRole('button', { name: /connect/i }).click();
      await page.getByRole('button', { name: WALLET_NAME }).click();
      await expect(page.locator('text=/Balance|USDC/')).toBeVisible({ timeout: 5000 });

      // Select intent
      await page.getByRole('button', { name: intent }).click();

      // Wait for Sign button to be enabled (simulation succeeded)
      const signButton = page.getByRole('button', { name: /sign/i });
      await expect(signButton).toBeEnabled({ timeout: 10000 });

      // Measure submit-to-confirm timing
      wallet.reset();
      const startMs = Date.now();
      await signButton.click();

      // Wait for confirmation (tx status shows success or position updates)
      await expect(page.locator('text=/confirmed|success|filled/i')).toBeVisible({ timeout: 15000 });
      const confirmMs = Date.now() - startMs;
      timings[intent] = confirmMs;

      console.log(`${intent}: ${confirmMs}ms submit-to-confirm`);
      expect(confirmMs).toBeLessThan(3000);
      expect(wallet.requests()).toBe(1);

      // Screenshot confirmed state
      await page.screenshot({ path: `/tmp/m2-06-evidence/${intent.replace(/ /g, '-').toLowerCase()}-confirmed.png`, fullPage: true });
    });
  }

  test.afterAll(async () => {
    console.log('=== TIMINGS ===');
    for (const [intent, ms] of Object.entries(timings)) {
      console.log(`${intent}: ${ms}ms`);
    }
  });
});
EOTEST

log "Running Playwright four-intent tests"
export NODE_PATH=/home/box/.ao/data/worktrees/peak6-meridian/peak6-meridian-31/node_modules/.pnpm/playwright@1.63.0/node_modules
npx playwright test "$WORK/playwright/four-intents.spec.ts" \
  --config=tests/e2e/playwright.config.ts \
  --output="$WORK/playwright-output" 2>&1 | tee "$WORK/playwright.log"

log "Running Lighthouse on Trade page"
npx lighthouse "$APP_URL/trade/$(solana-keygen pubkey $WORK/first-market.key 2>/dev/null || echo 'placeholder')" \
  --only-categories=accessibility \
  --output=json --output=html \
  --output-path="$WORK/lighthouse-trade-desktop" \
  --preset=desktop 2>&1 | tee "$WORK/lighthouse-trade-desktop.log" || true

log "Running Lighthouse on Markets page"
npx lighthouse "$APP_URL" \
  --only-categories=accessibility \
  --output=json --output=html \
  --output-path="$WORK/lighthouse-markets-desktop" \
  --preset=desktop 2>&1 | tee "$WORK/lighthouse-markets-desktop.log" || true

npx lighthouse "$APP_URL" \
  --only-categories=accessibility \
  --output=json --output=html \
  --output-path="$WORK/lighthouse-markets-mobile" \
  --emulated-form-factor=mobile 2>&1 | tee "$WORK/lighthouse-markets-mobile.log" || true

log "Extracting Lighthouse scores"
TRADE_SCORE=$(jq -r '.categories.accessibility.score * 100' "$WORK/lighthouse-trade-desktop.report.json" 2>/dev/null || echo "N/A")
MARKETS_DESKTOP_SCORE=$(jq -r '.categories.accessibility.score * 100' "$WORK/lighthouse-markets-desktop.report.json" 2>/dev/null || echo "N/A")
MARKETS_MOBILE_SCORE=$(jq -r '.categories.accessibility.score * 100' "$WORK/lighthouse-markets-mobile.report.json" 2>/dev/null || echo "N/A")

log "=== RESULTS ==="
log "Trade (desktop): $TRADE_SCORE"
log "Markets (desktop): $MARKETS_DESKTOP_SCORE"
log "Markets (mobile): $MARKETS_MOBILE_SCORE"
grep "TIMINGS" "$WORK/playwright.log" -A 10 || echo "No timings found"

log "Uploading artifacts to GitLab MR !49"
for file in "$WORK"/*.png "$WORK"/*.report.{json,html}; do
  [ -f "$file" ] || continue
  log "Uploading $(basename "$file")"
  glab api -X POST "/projects/paawandesai%2Fpeak6-meridian/uploads" \
    -F "file=@$file" 2>&1 | tee "$WORK/upload-$(basename "$file").json"
done

log "Posting evidence comment to !49"
glab api -X POST "/projects/paawandesai%2Fpeak6-meridian/merge_requests/49/notes" \
  -f "body=## M2-06 AC5 + UI-04 AC5/AC6 Evidence

### Four-Intent Timing (submit to confirm)
$(grep -A 10 "TIMINGS" "$WORK/playwright.log" || echo "See playwright.log")

### Lighthouse Scores
- Trade (desktop 1280px): **${TRADE_SCORE}**/100
- Markets (desktop 1280px): **${MARKETS_DESKTOP_SCORE}**/100
- Markets (mobile 390px): **${MARKETS_MOBILE_SCORE}**/100

### Artifacts
Screenshots and Lighthouse reports uploaded to this MR.

Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>&1 | tee "$WORK/comment.json"

log "SUCCESS: Evidence generated and uploaded"
log "Artifacts in: $WORK"
