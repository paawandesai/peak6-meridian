<!-- OWNER: human only. Operator may propose changes via MR; only the human approves them. -->
# Meridian: Brief

Meridian is a non-custodial dApp on **Solana devnet** for trading same-day (0DTE) binary contracts on the closing price of the seven "MAG7" US stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA). Each contract asks "Will TICKER close at or above STRIKE today?" and is a pair of tokens: YES pays $1.00 test-USDC if it does, NO pays $1.00 if it doesn't. Markets are created automatically every trading morning, trade on an on-chain order book, settle from an on-chain oracle after the 4:00 PM ET close, and winners redeem for USDC.

The build is a Gauntlet AI partner project for **PEAK6** (an options market maker since 1997; its PEAK6 Labs team builds Apex's Non-Traditional Assets Platform, including prediction markets). Evaluators read the code, invariants, and trade-off docs, not just the UI.

Detail: [requirements.md](requirements.md) · Domain rules: [domain.md](domain.md) · Design: [architecture.md](architecture.md) · Schedule: [plan.md](plan.md) · Why: [decisions.md](decisions.md)

## Problem
Retail traders want a simple, directional, same-day view on a large stock where max gain and max loss are known at entry: no Greeks, no margin. The system must enforce a fixed $1.00 payout invariant on-chain, run the daily lifecycle without humans, and settle correctly every day.

## Goals
1. Full daily lifecycle on devnet: create markets → mint pairs → trade (all four paths: Buy YES, Buy NO, Sell YES, Sell NO) → settle from the oracle → redeem.
2. The $1.00 invariants are enforced on-chain and never violated.
3. Settlement uses the official close and completes within 10 minutes of the close.
4. **Differentiator A:** a live book priced like an options desk: a fair-value engine, an autonomous market maker quoting every strike, and a market-implied distribution chart.
5. **Differentiator C:** a settlement ops agent (LLM) that investigates a failed settlement and drafts an admin override for a human to approve. It never signs anything.
6. Clear, defensible trade-off documentation.

## Non-goals
Mainnet or real funds; fees; integrating Phoenix or OpenBook; HyperLiquid; KYC, accounts or auth beyond wallet connect; mobile-specific UI; monitoring dashboards beyond the `/status` page; any regulatory or compliance claim; a natural-language trading copilot (Option B, dropped).

## Deliverables & deadlines
All times are as stated; the submission deadline is **Sunday Oct 11, 2026, 11:59 AM Central (12:59 PM ET)**. Code freeze: **Sunday Oct 11, 09:00 CT**.

| Deliverable | Due |
|---|---|
| GitLab repo (labs.gauntletai.com/paawandesai/peak6-meridian) with README and one-command local setup (`make dev`) | Sun Oct 11, 11:59 AM CT |
| Program deployed to Solana devnet (program ID in README) | Thu Oct 8, before 15:30 ET |
| Reproducible scripts: deploy, create markets, full lifecycle on devnet | Thu Oct 8 |
| Public frontend URL (Vercel) and automation running on trading days (Railway) | Thu Oct 8 |
| Real oracle settlement rehearsal on devnet | Thu Oct 8, 16:05 ET |
| **Recorded real settlement** (Friday's 4:00 PM ET close) for the demo video | Fri Oct 9, 16:05 ET |
| Tests that validate all key invariants, running in CI | M1 onward |
| docs/decisions.md, docs/architecture.md, docs/risks.md (risks/limitations, no regulatory claims) | Sun Oct 11 |
| Demo video (full lifecycle including Friday's real settlement) | Sun Oct 11, 11:59 AM CT |

The last real market close before the deadline is **Fri Oct 9, 4:00 PM ET**. Nothing that requires a live close can slip past it.

## Hard constraints
No agent or operator decision may violate these.
1. **Network:** Solana devnet and local validators only. Never mainnet, never real funds, never real USDC.
2. **Stack:** the program is Rust + Anchor; the frontend is TypeScript + React (Next.js); the automation service is TypeScript/Node. Python is used only for the fair-value engine, market maker, and ops agent. See [decisions.md](decisions.md) D-001, D-018.
3. **Invariants**, enforced on-chain and never weakened: vault = 1 USDC × pairs outstanding (exact); YES payout + NO payout = 1 USDC; tokens are minted only by mint-pair and burned only by redeem; a settlement outcome is immutable once written. Details: [domain.md](domain.md).
4. **Settlement integrity:** settle only from the oracle with the freshness and confidence checks in [domain.md](domain.md); the admin override only after its on-chain delay.
5. **Ops agent:** has no access to any private key and can never sign or submit a transaction. A human approves every override.
6. **Secrets:** never in the repo, logs, CI output, status or log files. `.env` is never committed.
7. **Budget:** Railway ≤ $5/month; Anthropic API ≤ $20 total for the week; data APIs on free tiers only; Vercel free tier. Any other spend needs the human.
8. **Tests:** CI never calls live or paid APIs. Tests are never deleted, skipped or weakened to make a ticket pass.
9. **Data:** collect no PII; wallet addresses are the only user identifiers.
10. **Claims:** no regulatory, compliance, or investment-advice claims anywhere (UI, docs, video).
11. **Dependencies:** every major dependency is justified in decisions.md (PRD requirement).
12. **Deadline:** the dates above. A projected miss goes to the human with cut options.
