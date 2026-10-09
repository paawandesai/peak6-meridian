#!/usr/bin/env bash
# Retake screenshots with fully loaded content (M4-01 AC3)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

STARTED_SERVICES=false
SCREENSHOT_DIR="$(mktemp -d)"

cleanup() {
    echo "[$(date)] Cleanup..."
    if [ "$STARTED_SERVICES" = true ]; then
        echo "[$(date)] Stopping services we started..."
        kill 0 2>/dev/null || true
        wait 2>/dev/null || true
    fi
    rm -rf "$SCREENSHOT_DIR"
}
trap cleanup EXIT

# Check if services already running
if timeout 2 bash -c 'cat < /dev/null > /dev/tcp/localhost/8899' 2>/dev/null; then
    echo "[$(date)] Validator already running on :8899"
else
    echo "[$(date)] Starting make dev..."
    make dev &
    STARTED_SERVICES=true
fi

# Wait for validator (up to 5 minutes)
echo "[$(date)] Waiting for validator :8899..."
for i in {1..300}; do
    if timeout 2 bash -c 'cat < /dev/null > /dev/tcp/localhost/8899' 2>/dev/null; then
        echo "[$(date)] Validator listening after $i seconds"
        break
    fi
    sleep 1
done

# Wait for app (up to 2 minutes after validator)
echo "[$(date)] Waiting for app :3000..."
for i in {1..120}; do
    if timeout 2 bash -c 'cat < /dev/null > /dev/tcp/localhost/3000' 2>/dev/null; then
        echo "[$(date)] App listening after $i seconds"
        break
    fi
    sleep 1
done

# Additional stabilization - wait for app to fully build and load content
echo "[$(date)] Waiting 30s for app to fully initialize..."
sleep 30

# Take screenshots with Playwright
echo "[$(date)] Taking screenshots..."

PAGES=(
    "http://localhost:3000|markets"
    "http://localhost:3000|trade"
    "http://localhost:3000/admin|faucet"
    "http://localhost:3000/status|status"
)

VIEWPORTS=(
    "390,844|mobile"
    "1280,720|desktop"
)

screenshot_num=1

for page_entry in "${PAGES[@]}"; do
    IFS='|' read -r url name <<< "$page_entry"

    for viewport_entry in "${VIEWPORTS[@]}"; do
        IFS='|' read -r viewport_size viewport_name <<< "$viewport_entry"
        IFS=',' read -r width height <<< "$viewport_size"

        output_file="${SCREENSHOT_DIR}/$(printf '%02d' $screenshot_num)-${name}-${viewport_name}.png"

        echo "[$(date)] Capturing $name ($viewport_name: ${width}x${height})..."

        npx playwright screenshot \
            --browser chromium \
            --viewport-size="${width},${height}" \
            "$url" \
            "$output_file"

        ((screenshot_num++))
    done
done

# Copy to docs/demo/
echo "[$(date)] Copying screenshots to docs/demo/..."
mkdir -p docs/demo
cp "$SCREENSHOT_DIR"/*.png docs/demo/

# Show sizes
echo "[$(date)] Screenshot sizes:"
ls -lh docs/demo/*.png

echo "[$(date)] Done! Screenshots in docs/demo/"
