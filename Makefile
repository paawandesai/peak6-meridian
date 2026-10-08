# Meridian: the Makefile is the only entry point (CLAUDE.md § Commands). Run from the repo root.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

# Tools installed by scripts/toolchain.sh take precedence over anything else on the machine.
NODE_VERSION := $(shell tr -d '[:space:]' < .nvmrc)
export PATH := $(HOME)/.cargo/bin:$(HOME)/.avm/bin:$(HOME)/.local/share/solana/install/active_release/bin:$(HOME)/.nvm/versions/node/v$(NODE_VERSION)/bin:$(HOME)/.local/bin:$(PATH)
export COREPACK_HOME := $(HOME)/.cache/node/corepack
export COREPACK_ENABLE_DOWNLOAD_PROMPT := 0
export NEXT_TELEMETRY_DISABLED := 1

PIP_AUDIT_VERSION := 2.10.1

.PHONY: help toolchain install install-rust install-js install-py build-local build-devnet \
	client lint typecheck test test-security coverage audit eval-live deploy-devnet e2e dev

help:
	@echo "Targets: toolchain install build-local build-devnet client lint typecheck test test-security coverage eval-live e2e dev"

## Toolchain (once per machine): pinned Rust, Agave CLI, Anchor, Node, pnpm, uv, cargo tools.
toolchain:
	scripts/toolchain.sh

## Install dependencies exactly as locked (AB-16).
install: install-rust install-js install-py

install-rust:
	cargo fetch --locked

install-js:
	pnpm install --frozen-lockfile

install-py:
	uv sync --locked --all-packages

## Program builds: local includes the test oracle, devnet never does (AB-22).
build-local:
	anchor build -- --features local-oracle

build-devnet:
	anchor build

## Regenerate the IDL and the typed TS client (packages/client/src/idl) from the local build.
## Run after any change to the program's interface and commit the result.
client: build-local
	mkdir -p packages/client/src/idl
	cp target/idl/meridian.json packages/client/src/idl/meridian.json
	cp target/types/meridian.ts packages/client/src/idl/meridian.ts
	pnpm exec prettier --write packages/client/src/idl

lint:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	pnpm exec eslint . --max-warnings 0
	pnpm exec prettier --check .
	uv run --locked ruff check .
	uv run --locked ruff format --check .

typecheck:
	pnpm -r run typecheck
	uv run --locked mypy

## Unit and integration tests.
test: build-local
	cargo test --workspace --exclude security-tests --locked
	pnpm -r --filter '!security-tests-ts' run test
	pnpm --filter app run build
	uv run --locked pytest services

## Abuse-case tests (tests/security, one file per AB ID). The Rust ones run the local build.
test-security: build-local
	cargo test --package security-tests --locked
	pnpm --filter security-tests-ts run test
	uv run --locked pytest tests/security/py

## Coverage gate: 80% lines for meridian-book, each TS package and each Python package.
coverage:
	cargo llvm-cov --package meridian-book --locked --fail-under-lines 80
	pnpm -r run coverage
	uv run --locked pytest services/quant --cov=meridian_quant --cov-fail-under=80
	uv run --locked pytest services/ops-agent --cov=meridian_ops_agent --cov-fail-under=80

## Dependency audits (AB-16, NFR-10); run by the CI job `audit:deps`.
audit:
	pnpm audit --audit-level high
	cargo audit
	uv export --frozen --no-hashes --no-emit-workspace > /tmp/req.txt && uvx pip-audit@$(PIP_AUDIT_VERSION) -r /tmp/req.txt

## Ops-agent evals against the real Anthropic API, capped by OPS_AGENT_BUDGET_USD (M1-11).
## Not part of CI: CI runs the same cases with the scripted fake (`make test`).
eval-live:
	uv run --locked python services/ops-agent/evals/run_live.py

## Devnet deploy (M2-01): program, test-USDC mint and Config; idempotent, refuses any non-devnet
## cluster by genesis hash. Needs the environment in docs/environment.md (§ Devnet deploy).
## Extra flags: make deploy-devnet DEPLOY_ARGS="--feeds deployments/feeds.devnet.json".
deploy-devnet:
	pnpm --filter meridian-scripts run deploy-devnet $(DEPLOY_ARGS)

## End-to-end smoke on a local validator.
e2e:
	scripts/e2e.sh

dev:
	scripts/dev.sh
