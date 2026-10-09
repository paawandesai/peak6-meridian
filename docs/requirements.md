<!-- OWNER: human only. Operator may propose changes via MR; only the human approves them. -->
# Meridian: Requirements

Source: the PEAK6 PRD "Meridian: Binary Stock Outcome Markets on Blockchain" plus human decisions in [decisions.md](decisions.md). Terms and business rules are defined once in [domain.md](domain.md); security IDs (AB-xx) are in [threat-model.md](threat-model.md).

## Personas
| Persona | Who | Goals | Pain points |
|---|---|---|---|
| **Trader** | Retail participant with a Solana wallet (Phantom/Solflare) | Express a same-day directional view on a MAG7 stock with known max gain/loss; exit early | Options are complex (Greeks, margin); custodial apps hide how settlement works |
| **Market maker (MM)** | Liquidity provider, human or bot | Mint pairs, quote YES on many strikes, see exposure and P&L | Empty books at launch; quoting dozens of strikes by hand |
| **Admin / ops** | The team operating Meridian | Markets created before the open; correct settlement within 10 minutes of close; a safe fallback when the oracle fails | Oracle outages at 4 PM; manual overrides under time pressure |
| **Evaluator** | PEAK6 engineer reviewing the build | Reproduce the lifecycle, verify invariants, judge trade-offs | Demos that can't be reproduced or verified on-chain |

## User stories
**US-01** As a Trader, I want to connect my wallet, see my test-USDC balance and claim test-USDC from a faucet so that I can trade on devnet.
- AC: Phantom and Solflare connect; balance shows within 3 s; a faucet claim adds the fixed amount once per 24 h per wallet.

**US-02** As a Trader, I want to browse active contracts grouped by ticker, with the live stock price, YES/NO prices and implied probability, so that I can pick a contract.
- AC: all 7 tickers shown with current price and active contract count; each contract card shows strike, YES price, NO price (= 100¢ − YES) and implied probability.

**US-03** As a Trader, I want to Buy YES with a market or limit order so that I profit if the stock closes at or above the strike.
- AC: one signature; YES balance appears in Portfolio after execution; implied NO price displayed.

**US-04** As a Trader, I want Buy NO to be a first-class action so that I profit if the stock closes below the strike.
- AC: market Buy NO mints a pair and sells YES at the best bid in **one atomic transaction with one signature**; limit Buy NO mints a pair and posts YES as a limit ask at (100 − NO limit); NO balance appears in Portfolio.

**US-05** As a Trader, I want to Sell YES so that I exit a bullish position for USDC.
- AC: sell order on the book; USDC received on fill; realized P&L shown.

**US-06** As a Trader, I want to Sell NO so that I exit a bearish position without knowing the mechanics.
- AC: one transaction buys YES at the ask and redeems the YES+NO pair for 1 USDC; realized P&L shown.

**US-07** As a Trader, I want the UI to stop me holding YES and NO on the same strike so that my position stays clear.
- AC: Buy YES is blocked while holding NO (and vice versa) with a prompt to exit first.

**US-08** As a Trader, I want to see the order book from the YES and the NO perspective so that I understand prices either way.
- AC: toggle between views of the same book; NO view shows YES asks as NO bids at 100 − p and YES bids as NO asks at 100 − p; updates within 3 s of a confirmed change.

**US-09** As a Trader or MM, I want a portfolio with entry price, current price, P&L and exposure so that I know where I stand.
- AC: per position: side, quantity, average entry, mark price, unrealized and realized P&L; MM sees net exposure per strike.

**US-10** As a Trader, I want a history of my executions so that I can audit my trades.
- AC: lists fills, mints, redeems with time, market, side, price, quantity, tx signature.

**US-11** As a Trader, I want to see each contract's settlement price and outcome and redeem winners in one click so that I collect my payout.
- AC: settled contracts show settle price, outcome, $1.00/$0.00 per side; Redeem signs one transaction and USDC arrives in the wallet; unredeemed tokens stay redeemable indefinitely.

**US-12** As an MM, I want to mint pairs and post limit orders for YES so that I can provide liquidity.
- AC: mint N pairs for N USDC; post and cancel limit orders; fills and P&L visible (US-09).

**US-13** As Admin, I want markets for all 7 tickers created automatically each trading morning, and to add strikes intraday, so that trading starts on time.
- AC: by 09:00 ET on trading days, markets exist for every strike from the strike algorithm; admin can add a strike for a ticker any time before close; holidays create nothing; early-close days use the early close time.

**US-14** As Admin, I want automatic oracle settlement with retries, alerts, an emergency override with an enforced delay, and pause/unpause so that settlement is correct and safe.
- AC: settlement attempted from 16:05 ET (or early close + 5 min), retried every 30 s for 15 min, then an alert; override is rejected before close + delay; pause stops minting and trading but never stops cancel, withdraw or redeem.

**US-15** As a Trader, I want to see each strike's fair value next to its market price and the market-implied distribution of today's close so that I can judge whether a price is rich or cheap.
- AC: fair YES value (cents) and edge shown per strike, updating at least every 5 s while the market is open; one distribution chart per ticker built from the strike ladder.

**US-16** As a Trader, I want every live strike to have quotes so that I can always trade.
- AC: during trading hours each open strike has a bid and an ask from the market maker unless the oracle/data is stale or within the final 2 minutes before close.

**US-17** As Admin, I want an ops agent to investigate a failed settlement and draft an override with evidence so that I can approve a correct price quickly.
- AC: on final settlement failure the agent produces an incident note (per-source prices, spread, staleness, calendar check) and a draft override price; the admin approves or rejects it; the agent never signs.

**US-18** As an Evaluator, I want one-command local setup and scripts that run the full lifecycle on devnet so that I can reproduce the build.
- AC: fresh clone + `make dev` runs locally; `make e2e` runs create → mint → trade (4 paths, 2 users) → settle → redeem; documented devnet scripts do the same on devnet.

**US-19** As an Evaluator or Admin, I want a `/status` page showing invariants and liveness so that I can verify the system is correct and on time.
- AC: per market: vault vs pairs outstanding, settlement status/time; per day: market creation time vs 09:00 ET, settlement time vs close, oracle age at settle.

## Functional requirements
| ID | Requirement | Stories | Priority |
|---|---|---|---|
| FR-01 | `initialize_config`: admin, automation authority, test-USDC mint, ticker list with oracle feed per ticker, staleness/confidence/override-delay parameters | US-13, US-14 | Must |
| FR-02 | `create_strike_market`: one market per ticker+strike+date with YES/NO mints, collateral vault, order-book escrow and book account; automation authority only | US-13 | Must |
| FR-03 | `add_strike`: admin creates an extra strike for a ticker before close | US-13 | Must |
| FR-04 | `mint_pair`: deposit N × 1 USDC, receive N YES + N NO | US-04, US-12 | Must |
| FR-05 | Order book: place limit, place IOC market order with worst-price limit, cancel own order, price-time priority, withdraw (`settle_funds`) proceeds | US-03, US-05, US-08, US-12 | Must |
| FR-06 | `buy_no`: mint pair + sell YES (IOC or resting limit) atomically | US-04 | Must |
| FR-07 | `sell_no`: buy YES (IOC) + pair-redeem atomically | US-06 | Must |
| FR-08 | `settle_market`: read the oracle on-chain, apply all checks in domain.md, write outcome; permissionless; only after close | US-11, US-14 | Must |
| FR-09 | `admin_settle_override`: admin-only, manual price, only after close + override delay, only if not settled | US-14 | Must |
| FR-10 | `redeem`: pair mode (YES+NO → 1 USDC, any time) and winner mode (after settlement, winner → 1 USDC, loser → 0) | US-06, US-11 | Must |
| FR-11 | `pause` / `unpause`: global, admin-only; blocks mint and new orders only | US-14 | Must |
| FR-12 | New orders and mints rejected at or after a market's close time | US-11 | Must |
| FR-13 | Morning job: read previous closes, compute strikes, create markets; idempotent; retry with backoff; alert on failure | US-13 | Must |
| FR-14 | Settlement job: settle every open market after close; retry every 30 s for 15 min; then alert and trigger the ops agent | US-14 | Must |
| FR-15 | NYSE calendar: skip holidays, use early-close times | US-13, US-14 | Must |
| FR-16 | Markets page | US-02 | Must |
| FR-17 | Trade page: strike list, book with YES/NO toggle, Buy YES/Buy NO/Sell YES/Sell NO panel, payoff sentence, countdown to close | US-03–US-08 | Must |
| FR-18 | Position-constraint enforcement in the UI | US-07 | Must |
| FR-19 | Portfolio page with P&L, exposure and Redeem | US-09, US-11 | Must |
| FR-20 | History page | US-10 | Should |
| FR-21 | Landing section (product explanation, live prices, connect CTA) on the Markets page | US-02 | Should |
| FR-22 | Test-USDC mint and rate-limited faucet | US-01 | Must |
| FR-23 | Wallet connect (Phantom, Solflare) and USDC balance | US-01 | Must |
| FR-24 | Fair-value engine (digital option pricing) | US-15 | Should |
| FR-25 | Autonomous market-maker bot | US-16 | Should |
| FR-26 | Market-implied distribution chart | US-15 | Should |
| FR-27 | Settlement ops agent (LLM, drafts only) | US-17 | Should |
| FR-28 | Admin page: add strike, pause/unpause, review and approve override drafts | US-13, US-14, US-17 | Should |
| FR-29 | `/status` page | US-19 | Should |
| FR-30 | Scripts: deploy to devnet, create markets, full lifecycle on devnet; `make dev`, `make e2e` | US-18 | Must |
| FR-31 | Docs: decisions, architecture, risks/limitations note | US-18 | Must |
| FR-32 | Alert webhook for job failures | US-13, US-14 | Must |
| FR-33 | Program emits an event for every state change (mint, order, fill, cancel, settle, redeem) | US-09, US-10, US-19 | Must |

## Non-functional requirements
| ID | Category | Requirement (measurable) | AB |
|---|---|---|---|
| NFR-01 | Performance | A confirmed transaction is reflected in the book and portfolio UI within 3 s on devnet | |
| NFR-02 | Performance | Every instruction fits in 400,000 compute units, including a taker order matching up to 8 resting orders (asserted in tests) | AB-10 |
| NFR-03 | Reliability | On every trading day the automation runs, all markets exist by 09:00 ET (from `/status`) | |
| NFR-04 | Reliability | All markets settled within 10 min of close when the oracle is healthy; otherwise an override draft exists within 20 min of close | |
| NFR-05 | Reliability | Morning and settlement jobs are idempotent: re-running creates no duplicates and does not fail on completed markets (tested) | |
| NFR-06 | Data accuracy | Settlement uses the official close. Until a second on-chain source is granted (D-054): one on-chain source verified by the program (RedStone signed packages, ≥ 3 of 5 pinned signers, package timestamp at or after close, posted ≤ 30 slots before settle), cross-checked off-chain against the official close from Tiingo and Twelve Data (difference ≤ 0.05%, trading date = market date); otherwise no settle, an alert and the override path. Once Pyth is added (M3-10): ≥ 2 on-chain sources, spread ≤ 0.05% of price, oracle update ≤ 30 slots old, read after close | AB-03, AB-04, AB-13 |
| NFR-07 | Correctness | Invariants hold after every instruction across ≥ 1,000 randomized instruction sequences (property tests) | AB-01, AB-02, AB-12 |
| NFR-08 | Security | Admin/automation instructions reject every other signer; outcome immutable; override delay enforced on-chain | AB-06, AB-07, AB-08, AB-19 |
| NFR-09 | Security | Order book: no instruction lets a user move another user's funds or orders; prices 1–99¢ only; minimum order size; max resting orders per user; no new orders after close or while paused | AB-09, AB-10, AB-11 |
| NFR-10 | Security | gitleaks reports 0 findings; dependency audits report 0 high/critical on every MR | AB-16, AB-17 |
| NFR-11 | Security | Ops agent has no key material; every output is schema-validated and range-checked; the injection/jailbreak eval suite passes 100% in CI | AB-14, AB-15, AB-20 |
| NFR-12 | Security | Each of the 4 trade intents maps to the correct instruction (tested); the UI simulates the transaction and shows the payoff before signing | AB-18 |
| NFR-13 | Security | Faucet: fixed amount, 1 claim per wallet per 24 h, devnet only | AB-21 |
| NFR-14 | Security | The test-only local oracle is compiled out of every devnet build (verified in CI) | AB-22 |
| NFR-15 | Usability | Every trade action needs exactly one wallet signature; the payoff sentence is shown before signing | |
| NFR-16 | Usability | Markets and Trade pages score ≥ 90 on Lighthouse accessibility (desktop Chrome) | |
| NFR-17 | Reproducibility | From a fresh clone on Linux with the toolchain installed, `make dev` is running within 15 min and `make e2e` passes | |
| NFR-18 | Maintainability | Line coverage ≥ 80% for the order-book crate, TypeScript and Python packages; CI pipeline ≤ 20 min | |

## Key metrics
| Metric | How it's measured | Target |
|---|---|---|
| Settlement correctness | Settled outcomes vs official close, checked by the e2e test and `/status` | 100% |
| $1 invariant | Vault balance vs 1 USDC × pairs outstanding, every market, `/status` + property tests | 0 violations |
| Market creation on time | Market create time vs 09:00 ET, `/status` | 100% of trading days |
| Settlement latency | `settled_ts − close_ts`, `/status` | ≤ 10 min |
| Oracle age at settle | Slots between oracle update and settle, from the settle event | ≤ 30 slots |
| Lifecycle reproducibility | `make e2e` in CI; devnet lifecycle script | Green on every MR to main |
| Book coverage | Share of open strikes with a two-sided quote during trading hours | ≥ 95% |
| Ops agent accuracy | Eval suite pass rate; drafted price within source range | 100% |
