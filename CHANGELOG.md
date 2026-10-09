# Changelog

All notable changes to Meridian will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-devnet-submission] - TBD

Initial devnet submission for Gauntlet evaluation.

### Milestone 1 - Core Program

- !2 M1-01: Scaffold the monorepo and GitLab CI
- !8 M1-02: Program skeleton (state, errors, events, stubs, config, client)
- !5 M1-03: Matching engine crate
- !13 M1-04: Markets and collateral
- !19 M1-05: Order instructions
- !21 M1-06: Buy NO / Sell NO and the four intents
- !18 M1-07: Settlement, override and winner redeem
- !7 M1-08: Strike calculator and NYSE calendar
- !9 M1-09: Switchboard feed definitions and devnet spike
- !23 M1-10: Lifecycle script, morning CLI and end-to-end smoke
- !10 M1-11: Ops-agent safety layer and injection/jailbreak eval suite
- !17 M1-12: App shell and read-only Markets page

### Milestone 2 - Devnet Deployment

- !29 M2-01: Devnet deploy script (program, test-USDC mint, config)
- !35 M2-02: Switchboard feeds live on devnet and pinned in config
- !26 M2-03: Automation morning job (scheduler, idempotent, alerts, health)
- !27 M2-04: Automation settlement job
- !28 M2-05: Market data API and Markets live data
- !46 M2-08: History page
- !34 M2-09: Faucet
- !40 M2-10: Minimal admin page (add strike, pause/unpause)
- !33 M2-12: Devnet lifecycle script and Thursday rehearsal

### Milestone 3 - Production Readiness

- !48 M3-04: /status page (invariants and liveness)
- !54 M3-06: Admin override review and approval

### UI Improvements

- !22 UI-01: Design spec and UI ticket wave
- !32 UI-01 v2: Research-grounded design spec
- !38 UI-02: Design tokens, app shell and shared UI components
- !53 UI follow-up: AppShell accepts children

### Infrastructure & CI

- !16 CI: manual MR pipelines + interruptible (operator-rules §6)
- !14 CI: raise test/coverage/e2e timeout to 2h for cold Rust builds
- !30 CI: skip Rust build on docs/TS-only changes
- !31 CI: fresh clone for secrets:gitleaks
- !51 CI: allow two Meridian heavy jobs in parallel
- !15 test(automation): explicit timeout for 2026 DST calendar property test

### Documentation

- !1 docs(operator): add Meridian runbook
- !3 docs(operator): log CI maintenance window and runner tags
- !4 docs(operator): post-M1-01 status and log
- !6 docs(operator): log D-045 Cursor docs-only tie-break
- !11 docs(operator): refresh status/log after M1-03 and M1-08
- !12 docs(operator): accept OQ-10 LiteSVM audit ignores as D-047
- !20 docs: D-048 UI clarity and usability pass
- !24 docs: M2 tickets (M2-01..M2-13)
- !36 docs: record Paawan decisions OQ-14, OQ-15, M2-11 deploy (D-049..D-051)
- !39 docs: record D-052 (M2-12 live run deferred to #28)
- !41 docs: record D-053 (devnet keypairs + data keys)
- !50 docs: M3 tickets (M3-01..M3-09)
- !59 docs: M4 tickets

### Bug Fixes

- !25 M1-07 follow-up: fixture close date + AB-22 ignore marker

### Known Limitations

See docs/risks.md for complete risk assessment and mitigation strategies.
