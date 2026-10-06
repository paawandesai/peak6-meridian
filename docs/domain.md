<!-- OWNER: shared. Operator may update to match reality; every change is logged in docs/decisions.md. -->
# Meridian: Domain rules

This file is the single source for business rules and units. If code disagrees with it, the code is wrong (or log a decision and update this file).

## Glossary
| Term | Meaning |
|---|---|
| Contract / market | One ticker + one strike + one trading date. "Will TICKER close at or above STRIKE today?" |
| YES token | Pays 1 USDC if close ≥ strike, else 0 |
| NO token | Pays 1 USDC if close < strike, else 0 |
| Pair | 1 YES + 1 NO; always worth exactly 1 USDC |
| Mint pair | Deposit N USDC into the market vault, receive N YES + N NO |
| Pair redeem | Burn N YES + N NO of the same market, receive N USDC (any time) |
| Winner redeem | After settlement, burn tokens; winners get 1 USDC each, losers 0 |
| Strike | The price level of a contract, a multiple of $10 |
| Settlement | Writing the binary outcome on-chain from the official close |
| Override | Admin-only settlement with a manual price, allowed only after an on-chain delay |
| Vault | Program-owned USDC account per market holding only pair collateral |
| Book escrow | Program-owned USDC and YES accounts per market holding funds of resting orders (separate from the vault) |
| Open orders balance | Per-user, per-market record of free USDC/YES owed to a user from fills or cancels, withdrawn with `settle_funds` |
| CLOB | Central limit order book; price-time priority |
| 0DTE | Expires the same day it's created |
| MAG7 | AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA |
| Fair value | Model price of YES from the digital-option formula below |
| Implied distribution | The strike ladder's YES prices read as P(close ≥ K) for each K |
| ET | America/New_York (handles EST/EDT) |

## Units (integers only, never floats on-chain)
- Test-USDC: SPL mint with **6 decimals**; 1 USDC = 1,000,000 base units.
- YES/NO mints: **0 decimals**; 1 token = 1 contract.
- Order price: **cents, integer 1–99** (u8). Cost of 1 contract at price p = p × 10,000 USDC base units.
- Strike: **cents** (u64). $680 → 68,000.
- Oracle value: Switchboard returns a decimal with 18 fractional digits (i128). Compare `close_scaled ≥ strike_cents × 10^16` exactly; never round the close.
- Trading date: ET calendar date as `YYYYMMDD` (u32). Close time: unix seconds (i64).

## Invariants (on-chain, every instruction)
1. Vault balance = 1,000,000 × pairs outstanding (exact). Fees, if ever added, go elsewhere.
2. YES payout + NO payout = 1 USDC for every settled market.
3. YES/NO supply changes only in `mint_pair` (+) and `redeem` (−). Before settlement, YES supply = NO supply = pairs outstanding. After settlement, winning-side supply = pairs outstanding.
4. A written outcome never changes.

Winner redeem accounting: after settlement, burning a winning token pays 1 USDC from the vault; burning a losing token pays 0. `pairs_outstanding` decreases by 1 for each winning token burned (each winner retires one pair's collateral). Losing tokens may be burned at any time and change nothing else.

## The four trade paths (one book: YES vs USDC)
| UI action | On-chain | Book side |
|---|---|---|
| Buy YES | Buy YES (limit or IOC) | takes asks / rests as bid |
| Sell YES | Sell YES | takes bids / rests as ask |
| Buy NO | `buy_no`: mint pair + sell YES | takes bids / rests YES ask at 100 − NO limit |
| Sell NO | `sell_no`: buy YES (IOC) + pair redeem | takes asks |

- NO price = 100 − YES price. NO view of the book: YES asks shown as NO bids at 100 − p; YES bids shown as NO asks at 100 − p.
- Market orders are IOC with a worst-price limit (default: 99¢ to buy, 1¢ to sell, user may tighten). Unfilled IOC remainder is cancelled. A market `buy_no` pair-redeems any unsold YES remainder in the same instruction, so the user never ends up holding YES from a market Buy NO. A market `sell_no` only pair-redeems the YES it actually bought.
- Limit Buy NO: the user holds YES (in escrow, on the book) + NO until the ask fills; this is the only allowed YES+NO state.
- Payoff sentence (UI, before signing): "You pay $X. You win $1.00 per contract if TICKER closes at or above $STRIKE." (NO: "below").

## Position constraint (frontend-enforced)
A wallet holding NO for a strike cannot Buy YES on that strike, and a wallet holding YES cannot Buy NO, until it exits. The UI shows the exit action instead. (Exception: the transient state of a resting limit Buy NO.)

## Order book rules
- One book per market; capacity 32 orders per side; min order size 1 contract; max 8 resting orders per owner per market; max 8 fills per instruction.
- Price-time priority. A new order that would self-trade cancels the owner's resting order first.
- Full book: a new resting order is accepted only if it beats the worst resting order on that side, which is then cancelled and its funds credited to its owner's open orders balance.
- Resting bids escrow USDC (p × 10,000 × qty); resting asks escrow YES.
- Fill proceeds to makers and cancel refunds go to the owner's open orders balance; the owner withdraws with `settle_funds` (the UI does this automatically).

## Market lifecycle and time rules
- States stored on-chain: `Open`, `Settled`. "Closed" means `now ≥ close_ts` and not settled.
- At or after `close_ts`: no `mint_pair`, no new orders, no `buy_no`/`sell_no`. Cancel, `settle_funds` and redeem always work.
- Pause (global): blocks `mint_pair`, new orders, `buy_no`, `sell_no`. Never blocks cancel, `settle_funds`, redeem, or settlement.
- `close_ts` = 16:00 ET on normal days, 13:00 ET on NYSE early-close days.
- Daily schedule (ET): 08:00 read previous closes + compute strikes; by 08:30 markets created; 09:00 visible and mintable; 09:30 open; close; close + 5 min settlement job.
- NYSE holidays: no markets. Remaining 2026: Thanksgiving Thu Nov 26 (closed), Fri Nov 27 (early close 13:00), Thu Dec 24 (early close 13:00), Fri Dec 25 (closed). The calendar module must be checked against nyse.com before adding years.

## Strike algorithm
Input: previous trading day's official close P (dollars).
1. For k in {−9, −6, −3, 0, +3, +6, +9} percent: raw = P × (1 + k/100).
2. Round to the nearest $10, halves up: strike = floor(raw / 10 + 0.5) × 10.
3. Drop strikes ≤ 0; deduplicate; sort ascending.
Use exact decimal arithmetic (integer cents), not binary floats.
Examples (from the PRD): META P = 680 → 620, 640, 660, 680, 700, 720, 740. AAPL P = 230 → 210, 220, 230, 240, 250 (5 after dedup).
Admin may add strikes before close (`add_strike`).

## Settlement rules
`settle_market` (permissionless) succeeds only if all hold:
1. Market is `Open` and `now ≥ close_ts`.
2. Two oracle feed accounts are passed, one per data source, and each is owned by the Switchboard On-Demand program with a feed hash equal to the one pinned in Config for that ticker and source slot.
3. Each feed value was updated ≤ `max_staleness_slots` (default **30**, ≈12 s) before the current slot (the settle transaction includes both feed updates) and after `close_ts`.
4. The two values differ by ≤ `max_conf_bps` (default **5 bps = 0.05%**) of their mean. Settle price = mean of the two.
5. Outcome = YES if close ≥ strike, else NO. Store settle price, oracle slot, timestamp, source = Oracle.

Date check: each feed job reads its source's latest official regular-session daily close. The chain can't see the bar's date, so `automation` verifies off-chain that both sources' latest bar date equals the market's trading date before it submits a settle transaction, and retries until it does. The M1 Switchboard spike tries to move this check into the feed job itself; until then it's a documented limitation.

Settlement job: first attempt at close + 5 min; retry every 30 s for 15 min; then alert and trigger the ops agent.
`admin_settle_override`: admin signer, market `Open`, `now ≥ close_ts + override_delay_secs` (default **3600**), stores source = Override.

## Fair value (Differentiator A)
- fair_yes = N(d2) where d2 = (ln(S/K) − σ²T/2) / (σ√T), r = 0, S = live price, K = strike, T = remaining regular-session seconds / (252 × 6.5 × 3600).
- σ = annualized 20-day realized volatility of daily closes, floored at 15%.
- At T ≤ 0: 1 if S ≥ K else 0. Output in cents, clamped to [1, 99] for display and quoting.

## Market maker defaults (operator may tune, Tier 1)
Quote fair ± 2¢, size 10 per side, max |inventory| 200 per strike, skew 1¢ per 50 contracts of inventory, pull all quotes if price data is older than 10 s or < 2 min to close.

## P&L
- Average-cost basis per (market, side). A Buy NO's cost = 100 − YES sale price per contract (the mint's 100¢ minus proceeds). A Sell NO's proceeds = 100 − YES purchase price.
- Mark: YES = book mid (or last trade if one side is empty; or fair value if no trades); NO = 100 − YES mark. After settlement: 100 or 0.
- Realized P&L on each exit; unrealized = (mark − avg cost) × qty.
