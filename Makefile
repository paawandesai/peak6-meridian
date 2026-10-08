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
	client lint lint-rust lint-js-py typecheck test test-rust-unit test-js-py-unit test-security \
	test-rust-security test-js-py-security test-rust-build coverage audit eval-live e2e dev

# CI memory caps (set by .gitlab-ci.yml; empty locally): e.g. VITEST_FLAGS=--maxWorkers=2,
# PNPM_R_FLAGS=--workspace-concurrency=1.
VITEST_FLAGS ?=
PNPM_R_FLAGS ?=
# CI: the `build` job runs build-local once and passes target/deploy + target/idl to later jobs as
# artifacts; those jobs set MERIDIAN_PREBUILT=1 so the tests don't run anchor build again.
BUILD_LOCAL := $(if $(MERIDIAN_PREBUILT),,build-local)

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

lint: lint-rust lint-js-py

lint-rust:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets --locked -- -D warnings

lint-js-py:
	pnpm exec eslint . --max-warnings 0
	pnpm exec prettier --check .
	uv run --locked ruff check .
	uv run --locked ruff format --check .

typecheck:
	pnpm -r run typecheck
	uv run --locked mypy

## Unit and integration tests (CI runs the Rust and JS/Python halves as separate jobs).
test: test-rust-unit test-js-py-unit

test-rust-unit: $(BUILD_LOCAL)
	cargo test --workspace --exclude security-tests --locked

test-js-py-unit:
	pnpm -r $(PNPM_R_FLAGS) --filter '!security-tests-ts' run test $(VITEST_FLAGS)
	pnpm --filter app run build
	uv run --locked pytest services

## Abuse-case tests (tests/security, one file per AB ID). The Rust ones run the local build.
test-security: test-rust-security test-js-py-security

test-rust-security: $(BUILD_LOCAL)
	cargo test --package security-tests --locked

test-js-py-security:
	pnpm --filter security-tests-ts run test $(VITEST_FLAGS)
	uv run --locked pytest tests/security/py

## Compile (don't run) the Rust test binaries; the CI `build` job warms the cargo cache with it.
test-rust-build:
	cargo test --workspace --exclude security-tests --locked --no-run
	cargo test --package security-tests --locked --no-run

## Coverage gate: 80% lines for meridian-book, each TS package and each Python package.
coverage:
	cargo llvm-cov --package meridian-book --locked --fail-under-lines 80
	pnpm -r $(PNPM_R_FLAGS) run coverage $(VITEST_FLAGS)
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

## End-to-end smoke on a local validator.
e2e:
	scripts/e2e.sh

dev:
	scripts/dev.sh
