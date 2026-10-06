#!/usr/bin/env bash
# CI only. GitLab caches only paths inside the project directory, so the tool directories that
# live under $HOME are symlinked into .ci-cache/, which the jobs cache.
set -euo pipefail

cache_root="${CI_PROJECT_DIR:?CI_PROJECT_DIR is not set (CI only)}/.ci-cache"
for dir in .cargo .avm .local/share/solana .cache/solana .local/share/pnpm/store .cache/uv; do
  mkdir -p "$cache_root/$dir" "$(dirname "$HOME/$dir")"
  if [ -e "$HOME/$dir" ] && [ ! -L "$HOME/$dir" ]; then
    echo "link-cache: $HOME/$dir already exists and is not a symlink" >&2
    exit 1
  fi
  ln -sfn "$cache_root/$dir" "$HOME/$dir"
done
