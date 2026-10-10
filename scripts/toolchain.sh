#!/usr/bin/env bash
# Idempotent install of the pinned Meridian toolchain on Linux (Ubuntu 24.04 / Debian bookworm).
#
# Usage: scripts/toolchain.sh [component...]
#   Components: apt rust solana anchor node uv cargo-llvm-cov cargo-audit
#   No arguments installs all of them (`make toolchain`). CI jobs pass only what they need.
#
# Pins: Rust in rust-toolchain.toml, Node in .nvmrc, pnpm in package.json "packageManager",
# everything else in the variables below.
set -euo pipefail

AGAVE_VERSION="2.1.21"
ANCHOR_VERSION="0.31.1"
NVM_VERSION="0.40.8"
UV_VERSION="0.12.23"
CARGO_LLVM_COV_VERSION="0.9.1"
CARGO_AUDIT_VERSION="0.22.2"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_VERSION="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$REPO_ROOT/rust-toolchain.toml")"
NODE_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc")"
PNPM_VERSION="$(sed -n 's/.*"packageManager": "pnpm@\([0-9.]*\)".*/\1/p' "$REPO_ROOT/package.json")"

export NVM_DIR="$HOME/.nvm"
export COREPACK_HOME="$HOME/.cache/node/corepack"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
NODE_BIN="$NVM_DIR/versions/node/v$NODE_VERSION/bin"
SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
export PATH="$HOME/.cargo/bin:$HOME/.avm/bin:$SOLANA_BIN:$NODE_BIN:$HOME/.local/bin:$PATH"

log() { printf '[toolchain] %s\n' "$*"; }
die() {
  printf '[toolchain] ERROR: %s\n' "$*" >&2
  exit 1
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

install_apt() {
  local pkgs=(build-essential pkg-config libssl-dev libudev-dev curl git ca-certificates)
  local missing=() pkg
  for pkg in "${pkgs[@]}"; do
    dpkg -s "$pkg" > /dev/null 2>&1 || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    log "apt deps already installed"
    return
  fi
  log "installing apt deps: ${missing[*]}"
  as_root apt-get update -qq
  as_root env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y -qq --no-install-recommends "${missing[@]}"
}

install_rust() {
  if ! command -v rustup > /dev/null 2>&1; then
    log "installing rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
      sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
  fi
  if rustup toolchain list | grep -q "^$RUST_VERSION-"; then
    log "rust $RUST_VERSION already installed"
  else
    log "installing rust $RUST_VERSION"
    rustup toolchain install "$RUST_VERSION" --profile minimal --no-self-update
  fi
  rustup component add --toolchain "$RUST_VERSION" rustfmt clippy llvm-tools-preview
  rustup default "$RUST_VERSION"
}

# cargo-build-sbf downloads the SBF platform tools on first use and cannot tell a finished
# download from an interrupted one, so build an empty crate once and leave a marker behind.
install_platform_tools() {
  local marker="$HOME/.cache/solana/.platform-tools-$AGAVE_VERSION"
  if [ -f "$marker" ]; then
    log "sbf platform tools already installed"
    return
  fi
  log "installing sbf platform tools"
  # Clear through the directory (in CI it is a symlink into the cache; keep it) rather than rm it.
  mkdir -p "$HOME/.cache/solana"
  find "$HOME/.cache/solana/" -mindepth 1 -delete
  local probe
  probe="$(mktemp -d)"
  mkdir -p "$probe/src"
  printf '[package]\nname = "sbf-probe"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[workspace]\n' \
    > "$probe/Cargo.toml"
  : > "$probe/src/lib.rs"
  (cd "$probe" && cargo build-sbf)
  rm -rf "$probe"
  touch "$marker"
}

install_solana() {
  if [ -x "$SOLANA_BIN/solana" ] && "$SOLANA_BIN/solana" --version | grep -q " $AGAVE_VERSION "; then
    log "agave cli $AGAVE_VERSION already installed"
  else
    log "installing agave cli $AGAVE_VERSION"
    sh -c "$(curl -sSfL "https://release.anza.xyz/v$AGAVE_VERSION/install")"
    "$SOLANA_BIN/solana" --version | grep -q " $AGAVE_VERSION " ||
      die "agave cli $AGAVE_VERSION not active"
  fi
  install_platform_tools
}

anchor_ok() {
  [ "$(anchor --version 2> /dev/null)" = "anchor-cli $ANCHOR_VERSION" ]
}

install_anchor() {
  if anchor_ok; then
    log "anchor $ANCHOR_VERSION already installed"
    return
  fi
  if [ "$(avm --version 2> /dev/null)" != "avm $ANCHOR_VERSION" ]; then
    log "installing avm $ANCHOR_VERSION"
    cargo install --git https://github.com/coral-xyz/anchor --tag "v$ANCHOR_VERSION" avm --locked --force
  fi
  log "installing anchor $ANCHOR_VERSION"
  avm install "$ANCHOR_VERSION" && avm use "$ANCHOR_VERSION"
  if ! anchor_ok; then
    # The release binary needs a newer glibc than Debian bookworm ships; build it instead.
    log "anchor release binary unusable here; building from source"
    avm install "$ANCHOR_VERSION" --from-source --force && avm use "$ANCHOR_VERSION"
  fi
  anchor_ok || die "anchor $ANCHOR_VERSION not active"
}

install_node() {
  if [ -x "$NODE_BIN/node" ]; then
    log "node $NODE_VERSION already installed"
  else
    log "installing node $NODE_VERSION via nvm $NVM_VERSION"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      curl -sSfo- "https://raw.githubusercontent.com/nvm-sh/nvm/v$NVM_VERSION/install.sh" |
        PROFILE=/dev/null bash
    fi
    # nvm.sh is not written for errexit/nounset shells.
    set +eu
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" --no-use
    nvm install "$NODE_VERSION" || die "nvm install $NODE_VERSION failed"
    set -eu
  fi
  if [ "$(pnpm --version 2> /dev/null)" = "$PNPM_VERSION" ]; then
    log "pnpm $PNPM_VERSION already installed"
  else
    log "installing pnpm $PNPM_VERSION via corepack"
    corepack enable --install-directory "$NODE_BIN"
    corepack prepare "pnpm@$PNPM_VERSION" --activate
  fi
}

install_uv() {
  if [ "$(uv --version 2> /dev/null | cut -d' ' -f1-2)" = "uv $UV_VERSION" ]; then
    log "uv $UV_VERSION already installed"
    return
  fi
  log "installing uv $UV_VERSION"
  curl -LsSf "https://astral.sh/uv/$UV_VERSION/install.sh" |
    env UV_INSTALL_DIR="$HOME/.local/bin" UV_NO_MODIFY_PATH=1 sh
}

install_cargo_llvm_cov() {
  if [ "$(cargo-llvm-cov llvm-cov --version 2> /dev/null)" = "cargo-llvm-cov $CARGO_LLVM_COV_VERSION" ]; then
    log "cargo-llvm-cov $CARGO_LLVM_COV_VERSION already installed"
    return
  fi
  log "installing cargo-llvm-cov $CARGO_LLVM_COV_VERSION"
  cargo install cargo-llvm-cov --version "$CARGO_LLVM_COV_VERSION" --locked
}

install_cargo_audit() {
  if [ "$(cargo-audit audit --version 2> /dev/null)" = "cargo-audit-audit $CARGO_AUDIT_VERSION" ]; then
    log "cargo-audit $CARGO_AUDIT_VERSION already installed"
    return
  fi
  log "installing cargo-audit $CARGO_AUDIT_VERSION"
  cargo install cargo-audit --version "$CARGO_AUDIT_VERSION" --locked
}

main() {
  cd "$REPO_ROOT"
  local components=("$@") component
  if [ "${#components[@]}" -eq 0 ]; then
    components=(apt rust solana anchor node uv cargo-llvm-cov cargo-audit)
  fi
  for component in "${components[@]}"; do
    case "$component" in
      apt) install_apt ;;
      rust) install_rust ;;
      solana) install_solana ;;
      anchor) install_anchor ;;
      node) install_node ;;
      uv) install_uv ;;
      cargo-llvm-cov) install_cargo_llvm_cov ;;
      cargo-audit) install_cargo_audit ;;
      *) die "unknown component: $component" ;;
    esac
  done
  log "done: ${components[*]}"
}

main "$@"
