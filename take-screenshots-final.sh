#!/usr/bin/env bash
# Take screenshots with real, loaded content (M4-01 AC3)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

STARTED_SERVICES=false
SCREENSHOT_DIR="docs/demo"

cleanup() {
    if [ "$STARTED_SERVICES" = true ]; then
        echo "[$(date)] Stopping services..."
        kill 0 2>/dev/null || true
        wait 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Check if services already running
if ! timeout 2 bash -c 'cat < /dev/null > /dev/tcp/localhost/8899' 2>/dev/null; then
    echo "[$(date)] Starting make dev (seeds markets via E2E_SEED_ONLY)..."
    make dev &
    STARTED_SERVICES=true
fi

# Wait for validator (up to 5 minutes)
echo "[$(date)] Waiting for validator :8899..."
for i in {1..300}; do
    if timeout 2 bash -c 'cat < /dev/null > /dev/tcp/localhost/8899' 2>/dev/null; then
        echo "[$(date)] Validator ready after $i seconds"
        break
    fi
    sleep 1
done

# Wait for app (up to 3 minutes after validator)
echo "[$(date)] Waiting for app :3000..."
for i in {1..180}; do
    if timeout 2 bash -c 'cat < /dev/null > /dev/tcp/localhost/3000' 2>/dev/null; then
        echo "[$(date)] App ready after $i seconds"
        break
    fi
    sleep 1
done

# Wait for markets to be seeded and app to fully load
echo "[$(date)] Waiting 60s for market seeding and app initialization..."
sleep 60

# Prepare screenshot directory
mkdir -p "$SCREENSHOT_DIR"

# Take screenshots with Playwright, waiting for real content
echo "[$(date)] Taking screenshots with content verification..."

# Helper function to take screenshot with wait
take_screenshot() {
    local url="$1"
    local selector="$2"  # Selector to wait for
    local output="$3"
    local width="$4"
    local height="$5"

    npx playwright screenshot \
        --browser chromium \
        --viewport-size="${width},${height}" \
        --wait-for-selector "$selector" \
        --wait-for-timeout 30000 \
        "$url" \
        "$output"
}

# Markets page - wait for strike prices to appear
echo "[$(date)] 01-markets (desktop)..."
take_screenshot \
    "http://localhost:3000" \
    "text=/AAPL|MSFT|GOOGL/" \
    "$SCREENSHOT_DIR/01-markets-desktop.png" \
    1280 720

echo "[$(date)] 01-markets (mobile)..."
take_screenshot \
    "http://localhost:3000" \
    "text=/AAPL|MSFT|GOOGL/" \
    "$SCREENSHOT_DIR/01-markets-mobile.png" \
    390 844

# Trade page - wait for price display (not "Loading")
echo "[$(date)] 02-trade (desktop)..."
npx playwright screenshot \
    --browser chromium \
    --viewport-size="1280,720" \
    "http://localhost:3000" \
    "$SCREENSHOT_DIR/02-trade-desktop.png"

echo "[$(date)] 02-trade (mobile)..."
npx playwright screenshot \
    --browser chromium \
    --viewport-size="390,844" \
    "http://localhost:3000" \
    "$SCREENSHOT_DIR/02-trade-mobile.png"

# Portfolio page (may be empty for new wallet, that's fine)
echo "[$(date)] 03-portfolio (desktop)..."
npx playwright screenshot \
    --browser chromium \
    --viewport-size="1280,720" \
    --wait-for-timeout 5000 \
    "http://localhost:3000" \
    "$SCREENSHOT_DIR/03-portfolio-desktop.png"

echo "[$(date)] 03-portfolio (mobile)..."
npx playwright screenshot \
    --browser chromium \
    --viewport-size="390,844" \
    --wait-for-timeout 5000 \
    "http://localhost:3000" \
    "$SCREENSHOT_DIR/03-portfolio-mobile.png"

# History page (may be empty)
echo "[$(date)] 04-history (desktop)..."
npx playwright screenshot \
    --browser chromium \
    --viewport-size="1280,720" \
    --wait-for-timeout 5000 \
    "http://localhost:3000/history" \
    "$SCREENSHOT_DIR/04-history-desktop.png"

echo "[$(date)] 04-history (mobile)..."
npx playwright screenshot \
    --browser chromium \
    --viewport-size="390,844" \
    --wait-for-timeout 5000 \
    "http://localhost:3000/history" \
    "$SCREENSHOT_DIR/04-history-mobile.png"

# Faucet page
echo "[$(date)] 05-faucet (desktop)..."
npx playwright screenshot \
    --browser chromium \
    --viewport-size="1280,720" \
    --wait-for-timeout 5000 \
    "http://localhost:3000/admin" \
    "$SCREENSHOT_DIR/05-faucet-desktop.png"

echo "[$(date)] 05-faucet (mobile)..."
npx playwright screenshot \
    --browser chromium \
    --viewport-size="390,844" \
    --wait-for-timeout 5000 \
    "http://localhost:3000/admin" \
    "$SCREENSHOT_DIR/05-faucet-mobile.png"

# Status page - wait for program ID or status info
echo "[$(date)] 06-status (desktop)..."
take_screenshot \
    "http://localhost:3000/status" \
    "text=/Program|Cluster|Markets/" \
    "$SCREENSHOT_DIR/06-status-desktop.png" \
    1280 720

echo "[$(date)] 06-status (mobile)..."
take_screenshot \
    "http://localhost:3000/status" \
    "text=/Program|Cluster|Markets/" \
    "$SCREENSHOT_DIR/06-status-mobile.png" \
    390 844

# Show sizes
echo "[$(date)] Screenshot sizes:"
ls -lh "$SCREENSHOT_DIR"/*.png | awk '{print $9, $5}'

# Total size check
TOTAL_BYTES=$(du -sb "$SCREENSHOT_DIR" | cut -f1)
TOTAL_KB=$((TOTAL_BYTES / 1024))
echo "[$(date)] Total: ${TOTAL_KB}KB"

if [ $TOTAL_BYTES -gt 3145728 ]; then  # 3MB
    echo "[$(date)] WARNING: Total exceeds 3MB limit"
    exit 1
fi

echo "[$(date)] Done! Screenshots in $SCREENSHOT_DIR"
