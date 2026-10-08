#!/usr/bin/env bash
# `make dev`: local validator (:8899) + local build deployed under a throwaway program ID +
# seeded config and markets + the app (:3000). Ctrl-C stops everything.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e.sh" --dev
