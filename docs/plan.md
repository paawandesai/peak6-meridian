<!-- OWNER: human only. Operator may propose changes via MR; only the human approves them. -->
# Meridian: Plan

Scheduled backward from the fixed dates in [brief.md](brief.md#deliverables--deadlines). All times ET unless marked CT. The two immovable anchors: **Thu Oct 8 16:05 ET** (rehearsal settlement on devnet) and **Fri Oct 9 16:05 ET** (the recorded real settlement). If either is at risk, cut scope from the latest milestone first; never cut the Must-haves listed under M1/M2.

| Milestone | Window | Ends |
|---|---|---|
| M1: Core lifecycle, local | Tue Oct 6 evening → Wed Oct 7 | Wed Oct 7, 23:59 |
| M2: Live on devnet with real oracle and full UI | Thu Oct 8 | Thu Oct 8, 16:30 (after rehearsal) |
| M3: Differentiators + recorded settlement | Thu Oct 8 evening → Fri Oct 9 | Fri Oct 9, 16:30 |
| M4: Harden, document, submit | Fri Oct 9 evening → Sun Oct 11 | Sun Oct 11, 09:00 CT (code freeze) |

---

## M1: Core lifecycle, local
**Goal:** the smallest end-to-end slice that runs: the full contract lifecycle on a local validator, driven by a script, tested in CI.
**Demoable outcome:** `make e2e` starts a local validator, deploys the program, creates a market, two users mint and trade all four paths, the market settles from the local test oracle, both users redeem, and the vault invariant holds at every step. CI runs it on every MR.
**Delivers:** US-03, US-04, US-05, US-06, US-11 (program side), US-12 (program side), US-18 (local) · FR-01–FR-12, FR-13 (strike computation + market creation, no scheduler yet), FR-15 (calendar module), FR-30 (local parts), FR-33 · NFR-02, NFR-05 (strike/creation idempotency), NFR-06 (on-chain checks with mocked oracle data), NFR-07, NFR-08, NFR-09, NFR-10, NFR-11 (guard + eval suite), NFR-14, NFR-18.

**Scope**
- Monorepo scaffold, toolchain pins, Makefile, GitLab CI with lint/typecheck/test/coverage/gitleaks/dependency audit/human-file guard/daily heartbeat (see M1-01 in docs/tickets/M1.md).
- `crates/meridian-book`: pure-Rust matching engine (fixed capacity, price-time priority, limit + IOC, cancel, min size, per-owner cap, bounded fills).
- `programs/meridian`: all PRD instructions (initialize config, create strike market, add strike, mint pair, place/cancel order, settle funds, buy NO, sell NO, settle market, admin override, redeem pair/winner, pause/unpause), events for every state change, all checks from [domain.md](domain.md).
- Oracle adapter reading a Switchboard On-Demand pull feed, plus a **test-only** local oracle behind a cargo feature that is never in a devnet build.
- Generated TypeScript client in `packages/client` with intent→instruction mapping for the four trade paths.
- `services/automation`: strike calculator and NYSE calendar as tested library code; a CLI that creates the day's markets on any cluster.
- `services/ops-agent`: the safety layer only (draft schema, validator, no-signing guarantee) plus the fixed prompt-injection/jailbreak eval suite with a mocked LLM.
- `app/`: Next.js shell with wallet connect and a read-only Markets page against the local validator.
- Switchboard feed definitions for the 7 tickers (official close from ≥ 2 sources), validated by a devnet spike script that runs only when API keys are present (not in CI).

**Exit criteria**
- [ ] CI green on main, including coverage floor, gitleaks, dependency audit, guard job.
- [ ] `make e2e` (end-to-end smoke of the demo path: create → mint → 4 trade paths with 2 users → settle → redeem) runs in CI and passes.
- [ ] Abuse-case tests in `tests/security/` for AB-01–AB-12, AB-14, AB-15, AB-17, AB-20, AB-22 pass.
- [ ] Property tests: invariants over ≥ 1,000 random sequences; strike algorithm properties.
- [ ] Devnet build verified free of the test oracle (AB-22).
- [ ] Switchboard spike result recorded in decisions.md (feed works on devnet, or the fallback D-005b is triggered as a Tier 3 question).

## M2: Live on devnet with real oracle and full UI
**Goal:** the PRD lifecycle running on devnet from the real oracle and the real UI, rehearsed at Thursday's close.
**Demoable outcome:** a public URL where a trader claims test-USDC, trades all four paths on a real MAG7 strike, watches the YES/NO book, and after Thursday's 16:05 ET settlement redeems a winner. Program ID on devnet explorer.
**Delivers:** US-01–US-11, US-13, US-14, US-18 (devnet) · FR-13, FR-14, FR-15, FR-16, FR-17, FR-18, FR-19, FR-20, FR-21, FR-22, FR-23, FR-28 (add strike + pause only), FR-30, FR-32 · NFR-01, NFR-03, NFR-04, NFR-06 (live), NFR-12, NFR-13, NFR-15, NFR-16.

**Scope**
- Devnet deploy script: program, test-USDC mint, config with the 7 pinned feeds; idempotent re-runs.
- Automation service on Railway: morning job 08:00 ET (create by 08:30), settlement job close + 5 min with 30 s retries for 15 min, alert webhook, calendar, health endpoint.
- Frontend on Vercel: Markets (with landing section), Trade (strike list, book with YES/NO toggle, 4-button panel with constraints, payoff sentence, countdown, simulate-before-sign), Portfolio (positions, P&L, settle funds, redeem), History (from events), faucet (`/api/faucet`), minimal admin page (add strike, pause/unpause).
- Playwright smoke for the main UI flows against a local validator.
- Thursday rehearsal: real morning job (or a manual run of it if after 08:00), real 16:05 settlement, results logged.

**Exit criteria**
- [ ] Program, frontend and automation deployed; URLs and program ID in README.
- [ ] All four trade paths executed from the UI on devnet with one signature each.
- [ ] Thursday's markets settled from the Switchboard feed within 10 min of close (or the failure diagnosed and fixed before Friday).
- [ ] Devnet lifecycle script runs end to end.
- [ ] Playwright smoke and all M1 checks green in CI.

## M3: Differentiators + recorded settlement
**Goal:** make the book alive and priced like a desk, add the ops agent, and capture Friday's real settlement on video.
**Demoable outcome:** every strike shows fair value vs market, the market maker keeps two-sided quotes on all strikes, a distribution chart per ticker updates live; a staged data-source fault on the local stack makes settlement fail its confidence check and the ops agent drafts the override for admin approval; Friday's real 16:05 settlement and redemption recorded.
**Delivers:** US-09 (MM exposure), US-12, US-15, US-16, US-17, US-19 · FR-24, FR-25, FR-26, FR-27, FR-28 (override approval), FR-29 · NFR-04 (override path), NFR-11 (live agent).

**Scope**
- `services/quant` (Python): fair value = digital-option price N(d2) from live price, strike, time to close, per-ticker volatility; published to the app; market-maker loop that mints inventory and quotes every open strike around fair value with spread, size limits, inventory skew; pulls quotes when data is stale or < 2 min to close.
- App: fair value and edge per strike; implied distribution chart per ticker; MM exposure in Portfolio; `/status` page with the metrics in requirements.md.
- `services/ops-agent`: live Claude-backed investigation with read-only tools (fetch each source, read oracle/market accounts, calendar), incident note + validated override draft, webhook to the admin page; admin page review/approve flow (admin signs in their wallet).
- Ops-agent demo runs on the local stack (`make demo-ops`): the local oracle reports one source off by 2%, the on-chain confidence check rejects settlement, and the agent investigates using recorded source fixtures plus the live Claude API. Fault injection (`FAULT_INJECT_SOURCE`) exists only in local mode (red-team rules: never against real services).
- Friday: morning job at 08:00 ET unattended; 16:05 ET settlement recorded.

**Exit criteria**
- [ ] ≥ 95% of open strikes two-sided during a 30-minute observation window.
- [ ] Ops agent demo run on the local stack: fault → rejected settle → draft within source range → admin approval → settled after delay.
- [ ] Friday's settlement recorded and verified on explorer.
- [ ] Eval suite 100% in CI; budget usage logged and under $20.

## M4: Harden, document, submit
**Goal:** a reproducible, documented, red-teamed submission.
**Demoable outcome:** the final demo video and a repo an evaluator can clone and run.
**Delivers:** FR-31, NFR-17, and closure of every open security finding of critical/high severity.

**Scope**
- Fresh-clone run of `make dev` and `make e2e`; README with one-command setup, devnet links, demo section.
- docs/risks.md (risks and limitations, no regulatory claims), architecture and decisions brought up to date; justification for every major dependency.
- Red-team pass per [threat-model.md](threat-model.md) rules; fixes with regression tests.
- Demo video (60–120 s story: Buy NO in one signature, YES/NO book, fair value + MM, Friday's real settlement, redeem, `/status` invariants; ops-agent clip).
- Code freeze Sun 09:00 CT; submission by 11:59 AM CT.

**Exit criteria**
- [ ] Fresh clone passes `make e2e` on a clean Linux machine.
- [ ] No open critical/high findings.
- [ ] Video, README, docs complete; submission sent by the human.

## Must-have coverage
Every Must FR is in M1 or M2: FR-01–FR-12 (M1), FR-13/FR-15 (M1 library + M2 scheduling), FR-14 (M2), FR-16–FR-19, FR-22, FR-23, FR-32 (M2), FR-30 (M1 local + M2 devnet), FR-31 (M4, started in M1), FR-33 (M1).
