<!-- OWNER: shared. Operator may update to match reality; every change is logged in docs/decisions.md. -->
# Decisions

Append-only. The operator appends entries and never edits or deletes human entries. Format: **ID · By · Tier (operator only) · Date**, then Decision / Why / Alternatives rejected / How to reverse. Human entries D-001–D-034 were made by Paawan during kickoff (Oct 5–6, 2026), several on Claude's recommendation; "Conflict" notes record where a later decision replaced an earlier one.

---
### D-001 · By: human · 2026-10-06
**Decision:** Solana devnet + Anchor (Rust) for the program; TypeScript/React/Next.js frontend; TypeScript/Node automation service.
**Why:** PRD preference; sub-second finality for an on-chain book.
**Alternatives rejected:** Solidity on an EVM L2 (latency justification burden); HyperLiquid (no custom instruments).
**How to reverse:** Not reversible this week.

### D-002 · By: human · 2026-10-06
**Decision:** Build our own minimal CLOB inside the program (must match PRD behavior: one YES/USDC book per strike, four trade paths).
**Why:** "More ambitious" path the PRD names; atomic Buy NO/Sell NO; fully testable locally.
**Alternatives rejected:** Phoenix / OpenBook v2 (CPI and per-strike market setup are large unknowns in 5 days).
**How to reverse:** Replace `crates/meridian-book` + order instructions with CPI to an external CLOB; large change.

### D-003 · By: human · 2026-10-06
**Decision:** Classic SPL Token for YES/NO; mint authority = market PDA.
**Why:** Enforces "mint only via mint pair" simply. **Alternatives rejected:** Token-2022 (no needed feature). **How to reverse:** Swap token program in market creation; tokens are per-day so new markets can switch.

### D-004 · By: human · 2026-10-06
**Decision:** Own devnet test-USDC mint (6 decimals) with a rate-limited faucet.
**Why:** Circle's devnet faucet is rate-limited; evaluators must be able to trade. **Alternatives rejected:** Circle devnet USDC. **How to reverse:** Point Config `usdc_mint` at another mint for new deployments.

### D-005 · By: human · 2026-10-06
**Decision:** Oracle = Switchboard On-Demand custom HTTP feeds on devnet, feed hashes pinned in Config, read through one adapter module. Pyth access is being asked about separately; the adapter keeps it swappable.
**Why:** Since 2026-07-31 Pyth requires a paid plan and US equities are on Pyth Pro ($5,000/month). Switchboard works on devnet with sources we choose.
**Alternatives rejected:** Pyth Pro (cost; trial scope on devnet unknown); Chainlink Data Streams 24/5 equities (Solana devnet support undocumented, sign-up; kept as backup); RedStone (single stocks unconfirmed); Switchboard Surge (crypto only).
**Fallback D-005b:** our own ed25519-signed price attestation (median of the same sources) if the M1 spike fails; adopting it is a Tier 3 question.
**Conflict:** brief.md v1 (2026-10-05) assumed Pyth (A3); superseded.
**How to reverse:** Implement another adapter behind the same interface; update Config feeds.
**Amended 2026-10-09 by D-054 (Paawan):** superseded. Switchboard is shut down (support ended 2026-09-25, Crossbar unreachable); the settlement oracle is now RedStone, verified in our own program, with Pyth planned as the second source. The "RedStone (single stocks unconfirmed)" rejection above no longer holds: all 7 tickers are served by `redstone-primary-prod` (checked 2026-10-09). The adapter interface stays.

### D-006 · By: human · 2026-10-06
**Decision:** Settlement price = the official regular-session close (closing auction), from two independent sources.
**Why:** Matches the PRD's "closing price" exactly; we control the sources.
**Conflict:** earlier "first oracle reading at or after 16:00 ET" (2026-10-05/06 draft) superseded.
**Alternatives rejected:** first print after 16:00 (a proxy, not the close). **How to reverse:** Change feed jobs to last-trade endpoints.

### D-007 · By: human · 2026-10-06
**Decision:** Freshness as tight as the chain allows: feed updates in the same transaction as `settle_market`; max staleness 30 slots (~12 s); max spread between the two sources 5 bps; override delay 3600 s. All in Config.
**Why:** Human asked to minimize staleness. **Conflict:** PRD/brief example of 5 minutes superseded. **Alternatives rejected:** 5-minute window. **How to reverse:** `update_config`.

### D-008 · By: human · 2026-10-06
**Decision:** Data sources: Tiingo and Twelve Data free tiers for official closes (one Switchboard feed each per ticker); Finnhub free tier as a third source for live quotes and cross-checks. The human creates the accounts and keys.
**Why:** Free, official daily closes, two independent vendors for the spread check. **Alternatives rejected:** Alpha Vantage (25 requests/day); paid feeds. **How to reverse:** Swap a feed definition and re-pin its hash.

### D-009 · By: human · 2026-10-06
**Decision:** Strike algorithm exactly as the PRD: ±3/6/9% and previous close, rounded to nearest $10, deduplicated; admin may add strikes. **How to reverse:** Change `services/automation` strike module.

### D-010 · By: human · 2026-10-06
**Decision:** The "no YES and NO on the same strike" position constraint is enforced in the frontend (PRD). **How to reverse:** Add an on-chain check (would block limit Buy NO's transient state; needs design).

### D-011 · By: human · 2026-10-06
**Decision:** `redeem` has pair mode (YES+NO → 1 USDC any time) and winner mode (after settlement).
**Why:** PRD says tokens are destroyed only via redeem; Sell NO needs to close a pair before settlement. **How to reverse:** Not needed; additive.

### D-012 · By: human · 2026-10-06
**Decision:** All markets are real (MAG7, PRD strikes, real close). No synthetic demo markets. Each market stores its own `close_ts` so NYSE early-close days settle correctly.
**Conflict:** brief.md v1 A5 ("short-fuse demo markets") superseded. **How to reverse:** n/a.

### D-013 · By: human · 2026-10-06
**Decision:** No fees. **How to reverse:** Add a fee account (separate from vault) and instruction changes.

### D-014 · By: human · 2026-10-06
**Decision:** History and P&L come from program events in transaction logs; no indexer or database. Plus a `/status` page with the PRD's impact metrics.
**How to reverse:** Add an indexer service later.

### D-015 · By: human · 2026-10-06
**Decision:** Frontend on Vercel (free tier, deployed via Vercel CLI from CI); automation, quant and ops-agent on Railway (~$5/month). The operator is pre-approved to deploy devnet builds to these two targets.
**Why:** Simple; Vercel's Git integration doesn't support self-hosted GitLab on free plans. PEAK6's info names no cloud provider. **Alternatives rejected:** GitHub Actions cron (not our host; timing drift); AWS (setup time).
**How to reverse:** Redeploy elsewhere; services are stateless except ops-agent drafts.

### D-016 · By: human · 2026-10-06
**Decision:** Repo on self-hosted GitLab (labs.gauntletai.com/paawandesai/peak6-meridian), GitLab CI on shared runners, `glab` CLI. **How to reverse:** n/a.

### D-017 · By: human · 2026-10-06
**Decision:** Testing: LiteSVM + proptest for the program and book; `anchor`/local-validator e2e; Vitest + fast-check (TS); pytest + hypothesis (Python); Playwright UI smoke from M2. Tooling follows PRD stack where specified (human asked to prefer PEAK6's stack elsewhere).
**How to reverse:** Swap frameworks per package.

### D-018 · By: human · 2026-10-06
**Decision:** Python (PEAK6's language) for the fair-value engine, market maker and ops agent; PRD-specified languages everywhere else. No Java.
**Why:** PRD is graded; PEAK6 lists Java/Python. **How to reverse:** Port services to TS.

### D-019 · By: human · 2026-10-06
**Decision:** At most 3 concurrent workers, as set in the operating rules (docs/operating-rules.md governs operator limits).
**Conflict:** an earlier decision the same day removed the worker cap ("as many as the orchestrator deems necessary"); superseded by the operating rules' limit of 3, confirmed by the human.
**How to reverse:** Human edits operating rules.

### D-020 · By: human · 2026-10-06
**Decision:** The demo is a recorded video that includes Friday Oct 9's real 16:05 ET settlement, plus the live devnet site and reproducible scripts. **How to reverse:** n/a.

### D-021 · By: human · 2026-10-06
**Decision:** Differentiators: **A** (fair-value engine, autonomous market maker, implied distribution chart) and **C** (settlement ops agent that drafts overrides, never signs). Option B (natural-language trade copilot) dropped.
**Conflict:** brief.md v1 recommended no LLM feature; superseded.
**How to reverse:** Drop the `quant` / `ops-agent` services; core lifecycle unaffected.

### D-022 · By: human · 2026-10-06
**Decision:** Two Rust crates: `crates/meridian-book` (pure matching engine) and `programs/meridian`. The program's shared files (state, errors, events, instruction stubs) are frozen by the scaffolding tickets; later tickets own disjoint instruction files.
**Why:** Avoid merge conflicts between parallel workers. **How to reverse:** Merge crates.

### D-023 · By: human · 2026-10-06
**Decision:** Agent Orchestrator on grokbot (Linux); Claude Code workers and orchestrator; Cursor reviewer; Grok operator bot runs the loop. **How to reverse:** n/a.

### D-024 · By: human · 2026-10-06
**Decision:** Deadline Sunday Oct 11, 2026, 11:59 AM Central; code freeze 09:00 CT. Deliverables per brief.md. Any extra Gauntlet submission requirements are an open question.

### D-025 · By: human · 2026-10-06
**Decision:** The ops agent uses the human's Anthropic API key, total budget cap $20 for the week; it never holds keys or signs; untrusted text is data.
**How to reverse:** Disable the service; the admin page still supports manual override.

### D-026 · By: human · 2026-10-06
**Decision:** Users authenticate by wallet only. One devnet admin keypair (no multisig) holds config/override/pause/add-strike; a separate automation authority creates markets; separate market-maker and faucet keypairs. Secrets live in GitLab CI masked variables and Railway env vars; never in the repo.
**How to reverse:** `update_config` to rotate authorities.

### D-027 · By: human · 2026-10-06
**Decision:** Integer units: YES/NO tokens with 0 decimals (1 token = 1 contract); prices in whole cents 1–99; strikes in cents; USDC base units. Details in domain.md.
**Why:** No rounding anywhere, so the vault invariant is exact. **How to reverse:** Data-model change (new deployment).

### D-028 · By: human · 2026-10-06
**Decision:** A test-only local oracle instruction behind cargo feature `local-oracle`, used for local e2e and demos; never compiled into devnet builds (CI verifies).
**Why:** Switchboard isn't available on a local validator. **Alternatives rejected:** cloning devnet feed accounts (stale, network-dependent CI). **How to reverse:** Remove feature.

### D-029 · By: human · 2026-10-06
**Decision:** Maker proceeds and cancel refunds accrue to a per-user OpenOrders account and are withdrawn with `settle_funds` (UI does it automatically).
**Why:** Matching doesn't need every maker's token accounts; bounded compute. **How to reverse:** Direct transfers to makers via remaining accounts.

### D-030 · By: human · 2026-10-06
**Decision:** `settle_market` is permissionless (oracle-checked); `create_strike_market` needs the automation authority; override, pause, add strike and config need admin.
**Why:** Anyone can settle correctly; a stolen automation key can't move funds or outcomes. **How to reverse:** Add signer checks.

### D-031 · By: human · 2026-10-06
**Decision:** Coverage floor 80% lines for `crates/meridian-book`, every TS package and every Python package, enforced in CI. The Anchor program is exercised via LiteSVM against the compiled `.so`, so it has no line-coverage gate; instead every instruction must have success and failure-path tests.
**How to reverse:** Change thresholds in CI config.

### D-032 · By: human · 2026-10-06
**Decision:** pnpm workspaces (JS), uv workspace (Python), cargo workspace (Rust), Makefile as the single entry point for all commands.

### D-033 · By: human · 2026-10-06
**Decision:** Two Switchboard feeds per ticker (one per source) checked for spread on-chain, rather than one feed taking a median internally.
**Why:** Makes the confidence check explicit and verifiable on-chain. **How to reverse:** One feed per ticker with job-level median; drop the spread check to the oracle's variance.
**Amended 2026-10-09 by D-054 (Paawan):** until Pyth is granted for all 7 tickers there is one on-chain source (RedStone), so the on-chain two-source spread check is suspended. In its place: a RedStone signer threshold on-chain (default 3 of 5) plus an off-chain check that the RedStone value is within 5 bps of the Tiingo/Twelve Data official close. The on-chain spread check returns as RedStone vs Pyth in M3-10 (#49).

### D-034 · By: human · 2026-10-06
**Decision:** The ops-agent demo runs on the local stack with fixture data and a staged faulty source; never against real services.
**Why:** Red-team rules of engagement; all real markets stay real (D-012). **How to reverse:** n/a.

---
<!-- Operator entries below. Format: ### D-0NN · By: operator · Tier N · YYYY-MM-DD -->


### D-035 · By: operator · Tier 1 · 2026-10-06
**Decision:** Pin the M1-01 toolchain to Rust **1.99.0** (rustfmt/clippy/llvm-tools-preview), Agave CLI **2.1.21** (SBF platform tools v1.43), avm/anchor-cli **0.31.1**, Node **22.23.3** (nvm 0.40.8), pnpm **9.15.9**, uv **0.12.23**, Python **3.12**, cargo-llvm-cov **0.9.1**, cargo-audit **0.22.2**, pip-audit **2.10.1**, gitleaks image **v8.30.1**; keep `anchor-*` crates at 0.31.1 (not 0.31.2) and `solana-program` 2.1.21 to match the CLI.
**Why:** Ticket requires exact pins; stack says Anchor 0.31.1. **Alternatives rejected:** taking crates.io 0.31.2 patch line without an explicit stack change. **How to reverse:** Edit pins in `scripts/toolchain.sh` / lockfiles and rerun `make toolchain`.

### D-036 · By: operator · Tier 1 · 2026-10-06
**Decision:** Keep SBF builds compatible with platform-tools cargo 1.79 via `rust-version = "1.79.0"`, `.cargo/config.toml` `resolver.incompatible-rust-versions = "fallback"`, and holding `blake3` at 1.8.2.
**Why:** Edition-2024 crates break Agave 2.1 platform tools. **Alternatives rejected:** `--tools-version` newer tools (ticket fixes `build-local = anchor build -- --features local-oracle`). **How to reverse:** Drop the pin when Agave ≥ 2.2 is adopted.

### D-037 · By: operator · Tier 1 · 2026-10-06
**Decision:** Use `package.json#pnpm.overrides` to force patched `next>postcss` 8.5.29 and `@coral-xyz/anchor>toml` 4.3.0 so `pnpm audit --audit-level high` passes.
**Why:** Upstream pins were vulnerable (GHSA on postcss/toml); overrides upgrade, they do not ignore. **How to reverse:** Drop overrides once upstream bumps.

### D-038 · By: operator · Tier 1 · 2026-10-06
**Decision:** Drive the placeholder `version` instruction tests natively (no LiteSVM in M1-01); LiteSVM arrives with the first stateful instruction in M1-02.
**Why:** Keeps cold CI build small (~7 CPU-min LiteSVM cost deferred). **How to reverse:** Add LiteSVM in M1-02 as planned.

### D-039 · By: operator · Tier 1 · 2026-10-06
**Decision:** Deny `clippy::unwrap_used`, `expect_used`, `panic`, `arithmetic_side_effects` in `programs/meridian` (allowed in tests via `clippy.toml`).
**Why:** Enforces program safety rules early. **How to reverse:** Relax allowlists in `Cargo.toml` / `clippy.toml`.

### D-040 · By: operator · Tier 1 · 2026-10-06
**Decision:** CI job shape for the shared 1 vCPU host: per-job `TOOLCHAIN` subset installs; cache via `scripts/ci/link-cache.sh`; `e2e` tagged `heavy` (shared runner); other jobs untagged (dedicated #291); `retry` only on `runner_system_failure` / `runner_interrupted`; `CARGO_INCREMENTAL=0`.
**Why:** Human runner rules + timeout raise; full cold install per job would be ~40 min. **How to reverse:** Prebuilt CI image removes subset/cache complexity.

### D-041 · By: operator · Tier 1 · 2026-10-06
**Decision:** Worker branch naming `ao/peak6-meridian-2/m1-01-scaffold-ci` (AO session-namespace prefix + ticket id).
**Why:** AO tracks MRs by session-namespace prefix. **How to reverse:** Rename convention in orchestrator rules only.

### D-042 · By: operator · Tier 1 · 2026-10-06
**Decision:** Add `make audit` and `install-rust|js|py` Makefile targets so CI and developers share one entry point.
**Why:** Ticket requires Makefile as sole entry point. **How to reverse:** Inline commands in `.gitlab-ci.yml` (not preferred).

### D-043 · By: operator · Tier 1 · 2026-10-06
**Decision:** `scripts/e2e.sh` refuses dirty `programs/meridian/src/lib.rs` / `Anchor.toml`, restores them on exit via `git checkout --`, uses `E2E_PAYER_KEYPAIR` or a throwaway payer (never `~/.config/solana/id.json`), configurable RPC/faucet ports.
**Why:** Trap would otherwise discard local work; safety for concurrent checkouts. **How to reverse:** Change script guards carefully.

### D-044 · By: operator · Tier 1 · 2026-10-06
**Decision:** Python packages use `uv_build` backend and `TypedDict` for placeholder `health()` payloads (no runtime deps yet).
**Why:** No extra download; nothing to audit until real boundaries. **How to reverse:** Switch backend / add pydantic when first real boundary lands.


### D-045 · By: operator · Tier 1 · 2026-10-06
**Decision:** For **docs-only** MRs (operator/shared-owned files only; no human-owned files), if the Cursor reviewer is stuck >20 minutes without a verdict—especially when the agent is exploring `gh` against this GitLab host—the operator may break the tie and merge once the GitLab pipeline is green and `detailed_merge_status=mergeable`, logging the tie-break on the MR and as a decision. Applied first for MR !4 (pipeline 39494 green; Cursor stuck on `gh` vs GitLab).
**Why:** Merge rules allow operator tie-breaks; docs-only risk is low; waiting indefinitely on a misconfigured Cursor/`gh` path blocks source-of-truth updates. **Alternatives rejected:** wait forever; merge code MRs without Cursor. **How to reverse:** Require Cursor approve even for docs-only; or fix Cursor GitLab auth so the >20m path is unused.

### D-046 · By: operator · Tier 1 · 2026-10-07
**Decision:** OQ-12 option **(b)** — replace vulnerable `bigint-buffer` (GHSA-3gc7-fjrx-p6mg native addon) with in-repo `packages/bigint-buffer-js` (upstream 1.1.5 pure-JS fallback, addon removed) via `pnpm.overrides` `@solana/buffer-layout-utils>bigint-buffer` → `link:./packages/bigint-buffer-js`. Human (Paawan) approved (b) on 2026-10-07 with the constraint that Switchboard/SDK u64/u128 layout behavior stay equivalent to upstream (no capability loss).
**Why:** Removes the vulnerable C addon from the install tree so `pnpm audit --audit-level high` / `audit:deps` passes without an ignore; keeps full `toBigIntLE|BE` / `toBufferLE|BE` API and layout encode/decode semantics used by `@solana/buffer-layout-utils` (reached via `@switchboard-xyz/on-demand`). Property-tested against upstream 1.1.5 JS path; SDK-chain u64/u128 round-trips covered in switchboard tests.
**Alternatives rejected:** (a) `pnpm.auditConfig.ignoreGhsas` for GHSA-3gc7-fjrx-p6mg (leaves native code installed); (c) third-party forks (AB-16 supply-chain risk; `@trufflesuite/bigint-buffer` still ships native code); (d) hand-writing Switchboard instructions without the SDK.
**How to reverse:** Drop the override and `packages/bigint-buffer-js`, restore stock `bigint-buffer@1.1.5`, and either accept the advisory (a) or find another remediation; re-run `pnpm install` + `make audit`.


### D-047 · By: human · 2026-10-07
**Decision:** Accept the six `.cargo/audit.toml` ignores for LiteSVM **dev-deps only** (OQ-10): RUSTSEC-2022-0093, RUSTSEC-2024-0344, RUSTSEC-2026-0258, RUSTSEC-2026-0098, RUSTSEC-2026-0099, RUSTSEC-2026-0104. Confirmed by Paawan 2026-10-07 ~10:17 CT.
**Constraints (PRD / security goals unchanged):**
- NFR-10 / AB-16 still enforced: `make audit` / CI `audit:deps` continues to run; new high/critical advisories still fail the job.
- Advisories are reachable only via the LiteSVM test harness (D-017), not the on-chain program, scripts, or services.
- Same family as OQ-6 / OQ-7 Solana 2.1 pin warnings; remove these ignores when the workspace moves to Agave ≥ 2.2.
- Product and PRD security goals are unchanged by this acceptance.
**Why:** Upstream Solana 2.1.21 / Anchor 0.31.1 line has no fixed versions; silencing is limited to the test harness path already documented in `.cargo/audit.toml`. **Alternatives rejected:** fail CI until Agave ≥ 2.2; replace LiteSVM. **How to reverse:** Drop the six entries from `.cargo/audit.toml` once Agave ≥ 2.2 (or another fixed line) is adopted, and re-run `make audit`.


### D-048 · By: human · 2026-10-08
**Decision:** A UI clarity and usability pass, designed by the orchestrator with Claude Code `/design`, refines D-001. The stack stays the same: Next.js 15 App Router + React 19 + Tailwind + Solana wallet-adapter; no component library, no new UI framework. The goal is faster comprehension for the personas in requirements.md, not decoration. Spec lives in `docs/design.md` (UI-01); implementation is UI-02+ worker tickets, reviewed by Cursor against the ticket and `docs/design.md`. The track never blocks or delays an M2/M3 exit criterion or the Thu/Fri 16:05 ET settlements; cuts are recorded as Tier 2 entries. Approved by Paawan 2026-10-07 ~20:32 CT.
**Why:** The evaluator's demo path (Buy NO in one signature → settle → redeem → invariants) has to be obvious at a glance, and a retail trader has to know what they win or lose before they sign.
**Alternatives rejected:** Adding a component library or design framework; leaving the M1/M2 pages as they are.
**How to reverse:** Revert the UI tickets; the existing pages still meet FR-16 to FR-19.


### D-049 · By: human · 2026-10-08
**Decision:** OQ-15 option **(a)**: the five display-only money helpers (`scaledToCentsFloor`, `formatUsdCents`, `formatUsdcBalance`, `formatPriceTenths`, `formatUsdSigned`; design.md §3) go in `packages/client/src/units.ts`, added once by UI-02 with fast-check tests. This is the single additive exception to "UI tickets may not touch `packages/client`". Answered by Paawan 2026-10-08 13:45 CT.
**Why:** One source for money strings, with floor rounding so a displayed price never contradicts an outcome. **Alternatives rejected:** (b) a separate client ticket first; (c) formatting in `app/` (breaks "amounts only through client helpers"). **How to reverse:** Move the helpers into `app/` and update the UI tickets' file lists.


### D-050 · By: human · 2026-10-08
**Decision:** OQ-14: the UI always shows the open/closed state **and when each happens**, on every market and strike: the open time and the close time in ET, a state badge (Open / Closing soon / Closed / Settling / Settled) and a countdown to the next transition. There is no pre-open gate that the program does not enforce: "open time" is the market's real creation time (from its `MarketCreated` event or creation transaction block time) and close is `close_ts`, so the display is never wrong. A real 09:30 ET open needs an on-chain `open_ts`; that is proposed as its own ticket for Paawan (M2-14 in `docs/tickets/M2.md`, not approved, not started) and is not faked in the UI. Applies to UI-03 and the Trade page (M2-06 / UI-04). Answered by Paawan 2026-10-08 13:45 CT.
**Why:** Showing only what the program enforces keeps the UI truthful; the user still sees both times and the next transition. **Alternatives rejected:** (a) as originally written, Open from creation with no times shown; (b) an on-chain `open_ts` now (a program change, held as M2-14); a UI-only 09:30 gate (would show a state the program does not enforce). **How to reverse:** Approve M2-14 and switch "open time" to `open_ts`.


### D-051 · By: human · 2026-10-08
**Decision:** M2-11 deploys from GitLab CI on `main` only, using the protected, masked CI variables `VERCEL_TOKEN` and `RAILWAY_TOKEN` on project 2084. `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are unset, so the job links or creates the Vercel project by name. No tokens go in the box environment. Budget: Vercel free tier, Railway ≤ $5/month (brief.md). Any `.gitlab-ci.yml` change needs Paawan's review and is never merged by the gate. Answered by Paawan 2026-10-08.
**Why:** Keeps deploy credentials in protected CI variables instead of agent sessions, and keeps CI changes human-reviewed. **Alternatives rejected:** tokens in the box env or local `.env`; deploys from feature branches. **How to reverse:** Move the tokens elsewhere and update M2-11 and `docs/environment.md`.


### D-052 · By: human · 2026-10-08
**Decision:** M2-12 (MR !33) is merged with its live devnet rehearsal (AC1) deferred to follow-up issue #28 ("M2-12 follow-up: live devnet rehearsal run (AC1)", labels M2 and blocked). The AC1 checkbox stays unticked until the live run's signatures, explorer links and `docs/log.md` line are attached to #28. Decided by Paawan 2026-10-08 13:53 CT.
**Why:** The script, the local-validator evidence and the runbook are done and reviewed; the live run is blocked on OQ-5 (keypairs) and OQ-11 (Switchboard keys), and holding the code behind it blocks nothing else. **Alternatives rejected:** keeping !33 open until the live run. **How to reverse:** Not applicable; the follow-up issue carries the remaining AC1 evidence.


### D-053 · By: human · 2026-10-08
**Decision:** OQ-5 and OQ-11 resolved by Paawan, 2026-10-08 14:37 CT. (1) The devnet program, admin (upgrade authority), automation and faucet keypairs are generated on the box and stored in masked, protected GitLab CI variables, with an encrypted backup on the box; nothing is committed. (2) The data API keys (`TIINGO_API_KEY`, `TWELVEDATA_API_KEY`, `FINNHUB_API_KEY`) are supplied as CI variables and passed to Switchboard through `variableOverrides` at request time, never embedded in feed JSON. (3) The program ID is **re-keyed**, because M1 discarded the original keypair for `3RovidBTwYzUfhniunxsUgnLzsbWz6qt3PGpvD23HDZq`: the new program ID is `H8SBU6m8sGRvKudUGhroDP4oEMyvF9QDhVc9wTFESXSm` (set in `declare_id!` and `Anchor.toml` by the M2-01 live MR).
**Public keys:** program `H8SBU6m8sGRvKudUGhroDP4oEMyvF9QDhVc9wTFESXSm`; admin and upgrade authority `6cp7ExvkgtdQuMyJXv26wg8Z2MBJT2idPdTkXx13F5Se`; automation `7JFyYPJyhJokQ3wMKHwJwb35MFj87snz52nTUS6qeEMy`; faucet `32eaD4Hp5WQ4UeD8S7eFVCVtxBvZuBpQzE4Byt7JLju7`. All are at 0 SOL until Paawan funds them on devnet. Key material and file contents are never recorded here.
**Why:** Unblocks the live M2-01 deploy and the Switchboard feeds (M2-02) without secrets in the repo or in agent environments. **Alternatives rejected:** keeping the old program ID (its keypair no longer exists); embedding API keys in feed job definitions (public on chain). **How to reverse:** Re-key again (new `declare_id!`, `anchor keys sync`, rebuild, redeploy) and rotate the CI variables.

### D-054 · By: human · 2026-10-09
**Decision:** Oracle = RedStone (Switchboard shutdown); Pyth as second source later. Decided by Paawan 2026-10-09 10:11 CT, recorded by the operator.
1. **Source:** RedStone `redstone-primary-prod` signed data packages from the free public gateways (`oracle-gateway-1.a.redstone.finance`, `oracle-gateway-2.a.redstone.finance`; historical packages at `/data-packages/historical/redstone-primary-prod/<ms>`). 5 signers; AAPL, MSFT, GOOGL, AMZN, NVDA, META and TSLA are all served by both gateways (checked 2026-10-09).
2. **On-chain verification in our own Anchor program:** secp256k1 recovery of each data package signature (`secp256k1_recover` syscall, Ethereum address of the signer), signer in an admin-pinned set (the 5 `redstone-primary-prod` addresses), and at least a signer threshold (default **3 of 5**) of distinct signers for the ticker's feed id at one timestamp; value = median of those signers. A permissionless instruction posts the verified value to a PDA per ticker, then `settle_market` reads it: the PDA must be this program's account for that ticker, the package timestamp at or after `close_ts` and within `max_package_delay_secs` (default 600) of it, and the post no more than `max_staleness_slots` (30) old. Values have 8 decimals.
3. **One on-chain source until Pyth lands:** the D-033 on-chain spread check is suspended. Off-chain, `automation` and `settle-now` take the package from ≥ 2 gateways (they must agree), verify the Tiingo and Twelve Data latest bar date = trading date, and require the RedStone value to be within **5 bps** of the official close; otherwise they do not settle, alert, and the ops agent / admin override path (`admin_settle_override`, enforced delay) applies.
4. **Pyth later:** Pyth (Core receiver or Pyth Pro; equity ids AAPL 922, AMZN 954, GOOGL 1163, META 1272, MSFT 1292, NVDA 1314, TSLA 1435) becomes the second on-chain source and restores the D-033 spread check once Paawan's Pyth key is granted for the other 6 equities (TSLA is already granted).
5. **Off-chain quotes and fair value stay on Finnhub/Tiingo:** sub-second data isn't needed (PRD: fair value ≤ 5 s, quotes ≤ 10 s; settlement ≤ 30 slots and within 10 min of close).
6. **Switchboard is removed** (code, feed definitions, `SWITCHBOARD_*` variables, docs) once the RedStone path is live. The !37 Railway deploy's required `SWITCHBOARD_QUEUE` / `SWITCHBOARD_FEEDS_JSON` are dropped in M2-16.
**Tickets:** M2-15 (#46) program adapter + devnet redeploy · M2-16 (#47) automation settle job / `settle-now` on RedStone with the official-close cross-check · M2-17 (#48) recorded fixtures and AB-03/04/05/13 tests · M3-10 (#49) Pyth second source (blocked on Paawan's Pyth grant) · M2-18 (#50) remove Switchboard. Live rehearsal #28 is blocked on M2-15/M2-16 instead of Switchboard.
**Why:** Switchboard support ended 2026-09-25 and Crossbar is unreachable, so M2-02 can't go live and nothing on devnet can settle from an oracle. RedStone is free, serves all 7 single stocks, and its signed packages can be verified in our own program with no third-party on-chain dependency. One verified on-chain source plus the off-chain official-close cross-check keeps the intent of NFR-04/NFR-06 until a second source is granted.
**Alternatives rejected:** Pyth now (only TSLA granted); RedStone's deployed Solana price adapter (`REDuYsnEucMweattdv4xQCYdU1i8Q2W92kdayrpY9rA` on devnet; RedStone's docs warn of devnet data gaps, and it adds a trusted third-party program); D-005b own ed25519 attestation (we would be the only signer); Chainlink Data Streams (sign-up; Solana devnet support undocumented).
**Conflict:** supersedes D-005 and suspends D-033's on-chain spread check until M3-10. Amends domain.md § Units and § Settlement rules and tickets M2-02 (superseded), M2-04 and M3-09 AC2. NFR-06 in requirements.md and AB-03/AB-04/AB-13 in threat-model.md are human-owned; their amendments are proposed in a separate MR that needs Paawan's `human-approved` label.
**Known limitation:** a RedStone value at or after 16:00 ET is the provider's price at the package timestamp, not necessarily the closing-auction print (D-006). The ≤ 5 bps off-chain check against the official close ties it to the close, and a miss goes to the override path.
**How to reverse:** The oracle adapter keeps its interface; implement another reader (Pyth, M3-10) behind it, change the pinned signer set or price accounts, and upgrade the program on devnet with `--allow-upgrade`.

### D-055 · By: human · 2026-10-09
**Decision:** Pyth Pro is the primary demo price source. Paawan got a Pyth Pro (Lazer) key: all equity feeds at 1ms (MAG7) plus crypto/FX. For the demo, Pyth drives live prices/quotes/fair value and settlement where feasible. RedStone (D-054) stays as the second on-chain source and fallback; settlement keeps the two-source check (D-033) when both are available. Demo historical replay (#52) is a permanent toggle shipping alongside live Pyth mode as soon as Pyth lands. The key is a server-only secret (`PYTH_API_TOKEN`), never in logs, commits, or the client bundle.
**Why:** Pyth Pro delivers 1ms equity data for all MAG7 tickers, enabling live demo with real-time price discovery. The two-source on-chain verification (D-033) returns with RedStone as the fallback, strengthening settlement integrity (NFR-06).
**Alternatives rejected:** RedStone-only (no live intraday); historical replay without live mode (less compelling demo); exposing PYTH_API_TOKEN client-side (AB-17 secret exposure).
**Conflict:** Supersedes "Pyth later" in D-054.
**How to reverse:** Remove Pyth adapter from settlement, use RedStone-only with off-chain official-close cross-check as in D-054 (3).
**Implementation:** (Tier-1 approval 2026-10-09) On-chain verification via native Ed25519Program instruction + Instructions sysvar. The program validates: (a) ed25519 ix program id, (b) signer pubkey equals pinned Pyth Lazer signer stored in operator-controlled Config (never hard-trusted from payload), (c) signed message bytes are EXACTLY the payload being parsed (offsets into that ix's data, preventing cross-ix attacks), (d) feed id maps to market's ticker, plus timestamp/staleness rules. Vendored minimal parser based on pyth-lazer-protocol v0.46.0 (SolanaMessage + PayloadData layouts). Alternative: Pyth Lazer verifier program pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt (deployed on devnet/mainnet) is available as a future integration option for delegating signature verification.

### D-056 · By: operator (recorded by the agent at Paawan's request, 2026-10-10) · Tier 1 · 2026-10-10
**Decision:** The Config `pyth_lazer_signer` is Pyth Lazer's production Ed25519 signer **`9gKEEcFzSd1PDYBKWAKZi4Sq4ZCUaVX5oTr8kEjdwsfR`** (hex `80efc1f480c5615af3fb673d42287e993da9fbc3506b6e41dfa32950820c2e6c`). Set with `make migrate-config` + `PYTH_LAZER_SIGNER` when Pyth settlement is turned on (docs/runbook.md § Pyth settlement); not set on devnet yet.
**Source:** (1) Authoritative, read 2026-10-10: the trusted-signer list in the Pyth Lazer program's storage account `3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL` (owner `pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt`; both addresses from https://docs.pyth.network/price-feeds/pro/integrate-as-consumer/svm), decoded with the `Storage` layout of `pyth-lazer-solana-contract` 0.8.0. Mainnet-beta: one trusted signer, this key, expires 2035-01-15. Devnet: this key (expires 2035-06-16) plus a second key `HaXscpSUcbCLSnPQB8Z7H6idyANxp1mZAXTbHeYpfrJJ` that mainnet does not trust. (2) Pyth DAO proposal OP-PIP-45 "Assign Douro as the trusted signer for Pyth Lazer" (https://forum.pyth.network/t/passed-op-pip-45-assign-douro-as-the-trusted-signer-for-pyth-lazer/1895, 2025-01-16, ~10-year expiry), and OP-PIP-113 (https://forum.pyth.network/t/ongoing-op-pip-113-enable-trusted-signer-for-pyth-lazer-on-cardano/2510), which lists the same key in full for Cardano. (3) Every update the Pyth Pro API returned on 2026-10-10 (the seven 2026-10-09 closes in `programs/meridian/tests/fixtures/pyth/` and live updates) carries this key and its signature verifies.
**Why:** `settle_market` trusts exactly one key, so it must be the one the API signs with and that Pyth's own verifier trusts on both clusters.
**Alternatives rejected:** the devnet-only second key (not trusted on mainnet, purpose undocumented); CPI into Pyth's verifier program instead of our own Ed25519 check (D-055: per-update fee, and it trusts their storage account).
**How to reverse:** `make migrate-config` with another `PYTH_LAZER_SIGNER`. If Pyth rotates its key, settlements fail with `PythWrongSigner` (admin override still works); re-read the storage account and re-pin.
