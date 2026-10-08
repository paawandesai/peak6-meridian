<!-- OWNER: shared. -->
# Meridian: UI design spec (UI-01 v2, D-048)

Scope: how every Meridian page looks and reads, grounded in [requirements.md](requirements.md), [domain.md](domain.md), [plan.md](plan.md) and [brief.md](brief.md). This file changes no code. Implementation lives in the UI wave tickets (UI-02 onward) in [tickets/M1.md](tickets/M1.md#ui-wave-d-048). Cursor reviews every UI MR against this file as well as its ticket.

Method: drafted with the frontend-design plugin (Claude Code's `/design` command was not available in the operator session). The baseline was the M1-12 code on MR !17 (`app/src/app/layout.tsx`, `components/app-shell.tsx`, `components/markets-view.tsx`); it is the only page that exists. "Before" screenshots of each page are taken by the implementing ticket, against `make dev`, and attached to its MR.

Nothing here adds a feature, a framework, a font, a CDN asset or a non-integer amount. Anything that would is listed under [Open questions](#open-questions) instead.

**v2 (research-grounded).** v2 keeps v1's structure, tokens and hierarchy and changes only what public products show better. The evidence is in [design-research.md](design-research.md) (ids `R-K*` Kalshi, `R-P*` Polymarket, `R-R*` Robinhood, `R-I*` Interactive Brokers, `R-N*` Nadex; adopt `A*` and avoid `V*` lists). Claims there are limited to fetched public pages; unverified ones are marked and are never the only reason for a change.

| v2 change | Section | Research | Tickets touched |
|---|---|---|---|
| Cost strip above the sign button (cost = max loss, pays if right, profit if right, fees, estimated total) | §3 Payoff sentence, §5 Trade | A1, A10; R-I3, R-R3, R-K3, R-R1 | UI-04 (AC9) |
| Average fill price and levels in the simulated result | §3 Payoff sentence | A2; R-K1 | UI-04 (AC9) |
| "How a strike settles" rule line and timeline strip | §3 (new), §5 Trade | A3, V6; R-K4, R-R4, R-I4, R-P3 | UI-04 (AC10) |
| Displayed-price rule: midpoint, or bid and ask when the spread is over 10¢; always-visible "not a price you can trade at" text | §3 Price, probability | A4, V2; R-P1, R-N1, R-K3b | UI-03 (AC4 scoped, AC7), UI-04 (AC9) |
| Portfolio filters (Open, Resting orders, Closed) and an "If right pays" column; value footnote | §2 Portfolio, §5 Portfolio | A5; R-K3, R-K3b | UI-05 (AC5) |
| "Closed does not mean settled" help text, once per page and in the Trade reason (never inside a badge) | §3 Market state | A6; R-K4, R-K6 | UI-03 (AC7), UI-04 (AC9) |
| "YES + NO = 100¢, NO is derived" line; NO range in the wide-spread case | §3 YES vs NO | A7, V1; R-R2, R-P1b | UI-03 (AC4 scoped, AC7), UI-04 (AC4 caption, AC9) |
| Connect copy: connecting asks for nothing and moves nothing; each trade is one signature | §5 Markets | A8, V4; R-P4 | UI-03 (AC7) |
| Market question carries the time: "at today's 16:00 ET close" | §2 Trade | A9; R-R4 | UI-04 (AC9) |

---

## 1. Who reads which page

P1 Evaluator and P2 Trader drive every choice. P3 Market maker needs only Portfolio to be dense and legible. P4 Admin needs only `/admin` to be legible.

| Page | P1 Evaluator (PEAK6 engineer) | P2 Trader (retail, has a wallet) | P3 MM | P4 Admin |
|---|---|---|---|---|
| Markets `/` | See the whole day at a glance: 7 tickers, every strike, live state, and that it is real on-chain data | Pick a stock and a strike that matches a view, in ≤ 2 clicks | — | — |
| Trade `/trade/[market]` | Check the four paths map to one book, one signature, simulate-before-sign | Know exactly what they pay and can win before signing | Read the book depth | — |
| Portfolio `/portfolio` | Verify P&L math against domain.md and the explorer | See what they hold, what it is worth now, and redeem winners | Net exposure and P&L per strike, dense | — |
| History `/history` | Audit every fill/mint/redeem against a tx signature | Confirm what happened | Same as trader | — |
| `/status` | Verify invariants (vault = pairs × $1) and liveness | — | — | Confirm settlement ran on time |
| `/admin` | See that override has a delay and needs a human | — | — | Add a strike, pause, approve an override draft without mistakes |

## 2. Information hierarchy per page

Read order, first → third. Anything not listed is secondary and visually quieter.

**Markets**
1. The seven tickers, each with live price, "as of" time and time to close.
2. Per ticker, the strike ladder: strike, YES price, NO price (100 − YES) and implied probability, with the live price drawn as a marker between the two strikes it falls between.
3. Market state per strike (open / closing soon / closed / settling / settled), then the landing copy and the connect CTA (FR-21) for first-time visitors.

Trading-date scoping: the reader returns every date's markets (devnet keeps old days), so a page never mixes days and never goes blank while markets exist. The **active date** is today's ET trading date when the reader result has markets for it, otherwise the most recent `trading_date` present in the result. "Today" is the current ET calendar date from `Intl.DateTimeFormat` (`timeZone: "America/New_York"`) as the `YYYYMMDD` number that `Market.trading_date` stores (`packages/client` `tradingDate`). One ladder per ticker holds only the active date's markets, with a single live-price marker and its own strike count; the header's next close and its empty states use the same set. When the active date is not today (weekends, holidays, and every morning before the day's markets exist at about 08:30 ET) the Markets page shows a line above the ladders, `Showing markets from {YYYY-MM-DD} (closed)`, so an evaluator who opens the app after Friday's close sees Friday's settled ladders, not an empty page. "No markets today" appears only for an empty reader result. Earlier days' positions and winnings are also reachable through Portfolio and History.

**Trade** (one strike)
1. The question in plain words, with the time: "Will NVDA close at or above $180.00 at today's 16:00 ET close?" (the time is the market's own `close_ts` in ET, so 13:00 ET on an early close; [A9](design-research.md#8-adopt)), with state, countdown to close and live price + as-of.
2. The 4-intent panel (Buy YES, Buy NO, Sell YES, Sell NO) with the payoff sentence, the cost strip and the simulated result directly above the single sign button, and the "How this strike settles" line (§3) under the question.
3. The book with a YES/NO toggle; then (M3) fair value, edge and the ticker's distribution chart.

**Portfolio**
1. Wallet total: USDC balance, redeemable now, unrealized P&L.
2. Positions table with three filters, Open, Resting orders and Closed ([A5](design-research.md#8-adopt), R-K3): market, side, qty, avg entry, mark, "If right pays", unrealized, realized; settled rows show outcome and a Redeem button. A footnote says the mark is the book midpoint, not a guaranteed sale price (R-K3b).
3. MM block: net exposure per strike (dense), open orders, unsettled open-orders balance.

**History**: (1) newest event first, with time ET, market, action, side, price, qty; (2) the tx signature linked to the devnet explorer; (3) filters.

**/status**: (1) per-market invariant row: vault vs pairs × $1, pass/fail in text; (2) today's liveness: markets created vs 09:00 ET, settled vs close, oracle age at settle; (3) per-market settlement detail.

**/admin**: (1) what is pending a decision (override drafts with evidence, delay remaining); (2) pause state with the consequence spelled out; (3) add strike.

## 3. How things are shown

Rule for everything below: **text plus colour, never colour alone.** Every coloured state also carries its word. Every price is integer cents rendered by the `packages/client` unit helpers; the UI never does float math on money.

### YES vs NO
- YES uses the `--mer-yes` hue (blue); NO uses `--mer-no` (amber). Blue and amber stay distinguishable for the common colour-vision deficiencies. Red and green are reserved for P&L sign and pass/fail, never for sides.
- Sides are always labelled with their full word, "YES" / "NO", plus a one-line meaning on first use per page: "YES pays $1.00 if NVDA closes at or above $180."
- The NO price is always shown as `100 − YES` in cents. It is never computed in floats.
- NO is derived, never separately quoted, so the pair always totals 100¢; the book's NO view and the Trade panel say so in one templated line with the live numbers (`NO {100 − yes}¢ = 100 − {yes}¢ YES; YES + NO = 100¢`, for example NO 42¢ = 100 − 58¢ YES). Products that quote the two sides separately can show a pair above $1 (R-R2, V1); the line makes it plain Meridian cannot ([A7](design-research.md#8-adopt)).

### The four intents
- One segmented control with four labelled buttons, in the domain order **Buy YES · Buy NO · Sell YES · Sell NO**, each with a sub-label that says the outcome: "wins if ≥ $180", "wins if < $180", "exit YES", "exit NO".
- Buy NO is first-class: same size and weight as Buy YES. It is not a toggle or a secondary option.
- Disabled intents (FR-18, below) stay visible with the reason on hover/focus and inline.
- Not tradable (market `Closed`, `Settling`, `Settlement delayed` or `Settled`, or the app `Paused`): at or after `close_ts`, and while paused, the program rejects `mint_pair`, new orders, `buy_no` and `sell_no` (FR-11, FR-12), while cancel, `settle_funds` and redeem keep working. The panel therefore shows all four intents **visible but disabled**, with one inline reason that matches the badge (`Paused: trading and minting stopped; cancel, withdraw and redeem still work`, `Closed: no new orders; settling at {HH:mm} ET`, `Settling…`, `Settlement delayed: automatic settlement has stopped; an admin override opens at {HH:mm} ET` (or `…; an admin override is available now` from `close_ts + override_delay_secs` on, see "Override time"), or `Settled YES at $181.42`), the sign button disabled, and no payoff sentence or simulation line (there is nothing to sign). In their place it lists only the actions that still work, using the existing M2 flows and the same single-signature rule: **Cancel** on the wallet's resting orders, **Withdraw** free balances, pair **Redeem** when the wallet holds both YES and NO (not once `Settled`), and, once `Settled`, winner **Redeem** showing the payout (`Redeem $40.00`, losing tokens pay `$0.00`). The book stays visible, read-only. In `Settlement delayed` the on-chain market is still `Open`, so the program accepts cancel, `settle_funds` and pair redeem; this is the window (from `close_ts + 20 min` until the override opens or a late settle) in which a stuck wallet most needs them. A trader who lands on a closed strike sees the reason and these actions, never an enabled-looking form.

Action matrix for non-tradable markets (what the program accepts; a control is shown only when it applies to the wallet, for example Cancel needs a resting order, Withdraw a free balance, pair Redeem both YES and NO):

| Market state | Buy / Sell / Mint | Cancel | Withdraw | Pair Redeem | Winner Redeem |
|---|---|---|---|---|---|
| Paused (otherwise Open or Closing soon) | absent | present | present | present | absent |
| Closed | absent | present | present | present | absent |
| Settling | absent | present | present | present | absent |
| Settlement delayed | absent | present | present | present | absent |
| Settled | absent | present | present | absent (pair mode needs `Open`) | present |

Paused + Settled follows the Settled row and paused + Closed the Closed row (see Precedence). Cancel stays available after settlement because `cancel_order` is not gated on market status, so a wallet with a resting order can still recover its escrow; Settled differs from the others only in having no pair Redeem and having winner Redeem.

### Market state
| State | Source | Badge text | Treatment |
|---|---|---|---|
| Open | `Open` and `now < close_ts − 15 min` | Open | neutral outline |
| Closing soon | `Open` and `close_ts − 15 min ≤ now < close_ts` | Closes in 12:04 | warn tint + live countdown |
| Closed | `now ≥ close_ts`, not settled, before close + 5 min | Closed, settling at {HH:mm} ET | muted |
| Settling | `Open` and `close_ts + 5 min ≤ now < close_ts + 20 min` (on-chain `Market` plus the clock) | Settling… (with ` (attempt n)` only when the attempt count is supplied, see below) | muted + spinner with text |
| Settlement delayed | `Open` and `now ≥ close_ts + 20 min` (the settlement job's window of a first attempt at +5 min and retries every 30 s for 15 min, domain.md, has ended) | Settlement delayed: automatic settlement has stopped; an admin override opens at {HH:mm} ET, and from `close_ts + override_delay_secs` on `…; an admin override is available now` (see "Override time") | warn outline, no spinner |
| Settled YES | `Settled`, outcome YES | Settled YES at $181.42 (see "Settle price display" below) | YES hue, solid |
| Settled NO | `Settled`, outcome NO | Settled NO at $178.10 | NO hue, solid |
| Override pending | an override draft exists (supplied, see below) | Override pending, available at {HH:mm} ET, and from `close_ts + override_delay_secs` on `Override pending, available now` | warn outline |
| Paused | global pause flag and the market is otherwise `Open` or `Closing soon` (see precedence below) | Paused: trading and minting stopped; cancel, withdraw and redeem still work | danger outline, banner on every page |

Help text for Closed, Settling and Settlement delayed (v2): "Trading has stopped. The result is set when settlement runs; closed does not mean settled." It appears in the Trade panel's reason for those states and once per page on Markets (under the page header, only while the active date has such a market). It never goes inside a badge or a ladder row, where it would overflow at 390 px. Kalshi makes the same point about open or undetermined markets and notes settlement timing varies (R-K4, R-K6; [A6](design-research.md#8-adopt)).

Precedence: `Paused` is a global flag (`Config.paused`), not a per-market status, so it never hides a market's own state. The global banner on every page always shows the pause. A market's badge and its Trade-panel reason come from the per-market state first (Settled, Settlement delayed, Settling, Closed); the `Paused` badge and reason apply only to a market that would otherwise be `Open` or `Closing soon`. Examples: paused and Settled YES shows the Settled YES badge with winner Redeem (pause blocks nothing for a settled market); paused and past `close_ts` shows Closed, with the banner saying why trading is stopped as well; paused and `Open` shows Paused. The actions offered are the union of what the program still accepts in the market's state, so pause never removes winner Redeem, Cancel, Withdraw or pair Redeem.

Data sources for the states: the app reads only on-chain state (`Market`, `Config`) and the clock. **The shipped M1-12 reader does not decode all of it yet:** it exposes only `settled`, `closeTs`, `strikeCents` and `pairsOutstanding` per market and reads no `Config`, so `outcome`, `settle_price_scaled` and `Config.paused` are not available until **UI-02 AC7 extends the reader** (`MarketRow` gains `outcome` and `settlePriceScaled`, `MeridianReader` gains `getConfig()`, `marketStatus` gains Closing soon and Settling). Every state and field below that needs them is gated on that ticket, and UI-03 to UI-08 depend on it. From those it derives Open, Closing soon, Closed, Settling (the badge reads `Settling…` with no attempt number, and for no longer than the job's window: from `close_ts + 20 min` it reads `Settlement delayed`, derived from the clock alone, so a spinner never runs for an hour after the job gave up), Settled YES/NO and Paused (`Config.paused`). The settlement attempt count lives in `services/automation` and override drafts in `services/ops-agent`; neither is readable by the app today. `StateBadge` therefore takes them as optional props (`attempt?: number`, `overridePending?: { availableAt }`): UI-02 tests those variants through props, UI-03 renders only the derivable states and passes neither, and `Override pending` and the attempt number appear in the app only once an M2/M3 ticket exposes that data (the /status and admin tickets, UI-07 and UI-08, consume it then).

Pre-open (09:00 to 09:30 ET): checked against the program, which has no 09:30 gate: `Market` has no open time, and `mint_pair` and order placement are blocked only by pause and `now ≥ close_ts` (AB-11). The 09:30 "open" in domain.md's daily schedule is automation timing (markets exist by 09:00), not an on-chain state. The UI therefore shows `Open` and allows every intent from creation, and adds no pre-open badge or Trade restriction (a UI-only rule the program does not enforce would mislead and could be bypassed anyway). Confirmation requested under Open questions.

Settling time: `{HH:mm}` in the Closed badge is `close_ts + 5 min` rendered in ET through the same `Intl.DateTimeFormat` path, so it is 16:05 ET on a normal close and 13:05 ET on an early-close day with no calendar in the app; it is never hardcoded.

Override time: `{HH:mm}` is `close_ts + override_delay_secs` (from the on-chain config, default 3600 s) rendered in ET with `Intl.DateTimeFormat` (`timeZone: "America/New_York"`), so it is 17:00 ET on a normal close, 14:00 ET on an early-close day with the default delay, and follows any change to the delay. It is never hardcoded. Settlement delayed has no upper bound, so a time already in the past is never printed: before `close_ts + override_delay_secs` the badge and Trade reason name `{HH:mm}`; at or after it they say `an admin override is available now` (Override pending: `available now`), derived from the same `getConfig().overrideDelaySecs` sum and the clock. The header's `Settlement delayed` text carries no time and is unaffected.

Settle price display: `settle_price_scaled` has 18 fractional digits and `packages/client` has no formatter in that direction today. UI-02 adds one small additive helper to `packages/client/src/units.ts` as an **explicit, single exception** to the "UI tickets touch no `packages/client`" rule: `scaledToCentsFloor(scaled: bigint): bigint`, a **display-only** conversion (integer division by `STRIKE_CENTS_TO_SCALED`, rounding **down**, rejects negatives), documented in `units.ts` as the one lossy conversion there (the rest of the file throws instead of rounding). It floors because settlement is exact (`close_scaled >= strike_cents × 10^16`) and strikes are whole cents, so `floor(close) >= strike` iff `close >= strike`: the displayed price can never contradict the outcome (a $179.996 close settles NO and shows $179.99, never $180.00). Display is `formatUsdCents(scaledToCentsFloor(x))` (next paragraph), so no UI code does arithmetic on money. Every settle price in the badges and mockups (`$181.42`, `$178.10`, `$231.02`) comes from this path.

Money strings: `formatUsdc` returns a bare 6-decimal string (`"181.420000"`) and throws on negatives, so it cannot produce the strings in this spec. The same UI-02 exception therefore adds two **display-only** formatters next to `scaledToCentsFloor` in `units.ts`, so every money string in the app has one source and no component formats money itself:
- `formatUsdCents(cents: bigint, sign: "auto" | "always" = "auto"): string` renders whole cents as `$181.42`, with thousands separators (`$1,250.00`). Negatives print `−$1.20` (U+2212, never a hyphen). With `"always"` non-zero amounts carry the sign (`+$3.80`, `−$1.20`); zero prints `$0.00`. The `Pnl` component uses `"always"`; prices, costs and payouts use `"auto"`.
- `formatUsdcBalance(baseUnits: bigint): string` renders a test-USDC balance as `1,250.00 test-USDC`, rounding **down** to whole cents so a balance is never overstated. The `test-` qualifier is part of the formatter output and every balance string: this is a devnet test mint (brief.md, decisions.md), and a bare `USDC` could be read as real funds.
Cent prices stay `62¢` (an integer `number` from the client plus the `¢` character; no formatter needed). `formatUsdc` and `parseUsdc` keep their exact, throwing behaviour for inputs and transactions; the display formatters never feed a transaction.

Fractional cents (Portfolio, domain.md § P&L): a mark can be a half cent (bid 58¢ and ask 61¢ give 59.5¢) and an average cost is rarely whole. The rule: **all position maths is exact `bigint` in USDC base units, never rounded until display.** The mark is the book mid in tenths of a cent, `(bid + ask) × 5` tenths, which is exact, and is converted to base units by `× 1,000`. Cost basis is carried as total cost in base units plus quantity; unrealized is `mark_base × qty − total_cost` and realized is a running base-unit total, so nothing divides before display. Two more display-only formatters render them, in the same UI-02 `units.ts` exception:
- `formatPriceTenths(baseUnits: bigint, perQty: bigint = 1n): string` renders a per-contract price to one decimal of a cent, rounding **down**, and drops a zero decimal: `42¢`, `42.5¢`, `59.5¢`. Average entry passes `(total_cost, qty)`; a mark passes `(tenths × 1,000n)`.
- `formatUsdSigned(baseUnits: bigint, sign: "auto" | "always" = "auto"): string` renders a base-unit amount as dollars and cents like `formatUsdCents`, flooring toward −∞ to the cent, so a gain is never overstated and a loss never understated (`+$0.20`, `−$1.21` for −$1.2049).
The Portfolio uses these for Avg, Mark, Unrealized, Realized and the totals line; `formatUsdCents` stays for amounts already in whole cents (cost, payout, strikes). No float is involved anywhere.

"Closing soon" is a UI threshold, not an on-chain state. The 15-minute value is a design default (Tier 1, changeable).

### Position-constraint block (FR-18, US-07)
When the wallet holds NO on this strike, Buy YES is replaced in place by an inline notice: "You hold 12 NO on this strike. Sell NO first to buy YES." with a "Sell NO" button that preselects the exit. Mirror text for YES. The resting limit Buy NO exception shows "Your limit Buy NO is resting; you hold YES in escrow until it fills."

### Price, probability, fair value, edge
- Price: `62¢` (integer cents, tabular figures). Implied probability is the same number with a different unit: `62%`. Show both together, price first: `62¢ · 62%`.
- **Displayed price rule (v2).** The YES price on the ladder and in headers is the book midpoint of the best bid and best ask, in integer cents (floor of the average, which is what `packages/client` `yesMidCents` computes), when both sides exist and the spread is at most 10¢. When only one side exists, or the spread is wider than 10¢, the ladder shows the bid and ask range instead (`55–70¢ YES`, with the text "wide spread") and no probability figure, so a thin book never prints a precise-looking number. Polymarket publishes the same midpoint rule with a 10¢ spread cutoff (R-P1); Nadex reads the midpoint of bid and offer as implied probability (R-N1). The midpoint is not a price anyone can trade at, and the page says so in always-visible text, once per page under the page header (not hover-only, so keyboard and 390 px users see it): "Prices are the midpoint of the best bid and ask, not a price you can trade at. Buying costs the ask; selling pays the bid." Kalshi gives the same warning for displayed values (R-K3b). In the range case the NO column shows the NO range derived from the same book (NO bid = 100 − YES ask, NO ask = 100 − YES bid). The ticket always shows the executable ask or bid ([A4](design-research.md#8-adopt), V2).
- Fair value (M3): `Fair 58¢` next to the market price; edge = market − fair, signed, in cents: `Edge +4¢ (rich)` / `Edge −3¢ (cheap)`. Rich/cheap is always written, never only coloured.

### Data staleness and time
- Every page header shows the current time in ET ("14:52:07 ET") and the next close countdown. The next close is the smallest on-chain `close_ts` with `now < close_ts` among the active date's loaded markets (see "Trading-date scoping") whose on-chain status is `Open` (so markets badged Open and Closing soon both count; the badge thresholds in the state table play no part), and early-close days need no calendar in the app. Empty states, always as text: empty reader result → "No markets today"; markets exist, none with on-chain status `Open` and `now < close_ts`, some unsettled → "Closed · settling", or "Settlement delayed" when any of the active date's unsettled markets is in that state (it wins, being the one that needs attention); all settled → "Markets closed" (no countdown; on a past active date the Markets page also carries the "Showing markets from" line). The header never counts down to a time it computed itself.
- Every live number shows its "as of" time on hover and inline where space allows ("as of 14:52:05 ET").
- Staleness: data older than 10 s (domain.md MM threshold) gets a "stale" label and a muted style. Older than 60 s gets a banner: "Prices are 1 min old. Trading still works; check the book before you sign."
- Times are always ET, formatted with the platform's IANA time zone support (`Intl.DateTimeFormat` with `timeZone: "America/New_York"`), which handles DST and adds no dependency (the app has no tz library and the NYSE calendar stays in `services/automation`). No UTC offsets, no calendar in the app.

### Transaction state
One inline status line under the sign button, never a modal: `Simulating…` → `Review and sign in your wallet` → `Confirming…` → `Confirmed in slot 123456 (view on explorer)` or `Failed: <program error in plain words>. Nothing was charged.` Each state has text and an icon. The confirmed row shows in the book and in Portfolio within 3 s (NFR-01).

### Payoff sentence and simulated result (NFR-12, NFR-15)
Directly above the single sign button, always visible before signing:
> You pay **$3.80** for 10 contracts. You win **$10.00** (profit $6.20) if NVDA closes **below $180** today. Max loss $3.80.
Below it, the simulation result: "Simulated: fills 10 at 38¢ NO (62¢ YES bid). 1 signature." The sign button stays disabled until simulation succeeds.

**Cost strip (v2).** Between the sentence and the simulation line, four labelled figures in one row (wrapping at 390 px), all from the simulated result and the integer-unit helpers, none computed in the component: **You pay** (this is also the most you can lose), **Pays if right**, **Profit if right**, **Fees**. For Buy YES and Buy NO: `You pay $3.80 · Pays if right $10.00 · Profit if right $6.20 · Fees $0.00 (network fee in devnet SOL)`. For Sell YES and Sell NO: `You receive $4.20 · Gives up if right $10.00 · Fees $0.00 (network fee in devnet SOL)`, where the amount received is the simulated proceeds in integer cents: selling N contracts at p¢ gives `N × p¢` (the sum over levels for a multi-price fill), so 10 at 42¢ shows $4.20, and "gives up if right" is `N × $1.00`. Amounts in the examples are illustrative; the labels are the template. IBKR's ticket lists "Potential Profit and Maximum Loss" and "Estimated Total for the Order" before the order (R-I3), and both Robinhood and Kalshi stress that a payout is not the profit (R-R3, R-K3), so the strip prints profit next to the payout rather than leaving the subtraction to the reader. The fee figure is explicit because fees are the first thing Robinhood's pricing pages discuss (R-R1) and a missing line reads as hidden; Meridian charges none, and the network fee is paid in devnet SOL, not USDC ([A1](design-research.md#8-adopt), [A10](design-research.md#8-adopt)). The strip adds no second source of truth: it repeats the figures the sentence already states, and the sentence stays the NFR-12/NFR-15 element.

**Average fill (v2).** A market-sized order that walks several price levels reports the volume-weighted average and the level count, as in Kalshi's panel (R-K1, [A2](design-research.md#8-adopt)): `Simulated: fills 10 at an average 38.5¢ NO across 2 prices (YES bids 62¢ ×6, 61¢ ×4). 1 signature.` The average is `formatPriceTenths(total_cost, qty)`, rounded down, never overstated.

### How a strike settles (v2)
Every market page and every strike row's detail carries the rule in plain words, because every product that publishes market rules puts the resolution source next to the market (R-K4, R-R4, V6):
> Settles on the average of two official closing prices (Tiingo and Twelve Data) for {YYYY-MM-DD}. YES wins at or above $180.00, NO wins below. The price must agree within 0.05%.

and a timeline strip with times in ET from `close_ts` (never hardcoded; 13:00 on an early close): `Trading stops 16:00 ET · Settlement about 16:05 ET · Redeem after settlement`. IBKR shows each contract's last trading time, results release and payout (R-I4); Robinhood's event page names the source, rounding and payout timing (R-R4); Polymarket tells winners redemption has no deadline (R-P3), but Meridian only says what [domain.md](domain.md) states: winner redeem is available after settlement ([A3](design-research.md#8-adopt)). The 0.05% figure is `max_conf_bps` from `Config` when the reader exposes it and is omitted otherwise.

### Win/lose P&L
- Positive P&L: `+$3.80` with `--mer-gain`; negative: `−$1.20` with `--mer-loss`. The sign character is always printed.
- Settled outcomes print `$1.00` / `$0.00` per side (US-11).

## 4. Tokens

CSS custom properties in `app/src/app/globals.css`, exposed to Tailwind v4 through `@theme`. Light is the default; `prefers-color-scheme: dark` swaps values, and component code uses only token names. System font stacks only, so no new font dependency (a web font would be a Tier 2 decision).

```css
:root {
  /* colour */
  --mer-paper: #F7F9FC;      /* page background: cool, not cream */
  --mer-surface: #FFFFFF;    /* panels */
  --mer-ink: #13233A;        /* primary text (navy ink, AA 15.0:1 on paper, 15.8:1 on white) */
  --mer-ink-muted: #4A5B72;  /* secondary text (AA 6.6:1 on paper, 6.9:1 on white) */
  --mer-rule: #D5DDE8;       /* non-essential dividers and ladder rails only (1.3:1, decorative) */
  --mer-control-border: #6B7C93; /* borders of inputs, buttons, the intent control (non-text AA: 4.0:1 on paper, 4.3:1 on surface) */
  --mer-yes: #1E5BB8;        /* YES (AA 6.5:1 on white, 6.1:1 on paper) */
  --mer-no: #A4500A;         /* NO amber-brown (AA 5.6:1 on white, 5.3:1 on paper) */
  --mer-on-yes: #FFFFFF;     /* text on a solid YES fill (6.5:1) */
  --mer-on-no: #FFFFFF;      /* text on a solid NO fill (5.6:1) */
  --mer-gain: #146C43;       /* +P&L, pass */
  --mer-loss: #B42318;       /* −P&L, fail */
  --mer-warn: #8A5A00;       /* closing soon, stale, override pending */
  --mer-focus: #1E5BB8;      /* 2px focus ring + 2px offset */
  /* space (4px base) */
  --mer-space-1: 4px; --mer-space-2: 8px; --mer-space-3: 12px;
  --mer-space-4: 16px; --mer-space-6: 24px; --mer-space-8: 32px;
  /* type: system stacks, 1.25 scale, tabular numbers for all prices */
  --mer-font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mer-font-num: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
  --mer-text-xs: 0.75rem; --mer-text-sm: 0.875rem; --mer-text-md: 1rem;
  --mer-text-lg: 1.25rem; --mer-text-xl: 1.5625rem; --mer-text-2xl: 1.953rem;
  --mer-radius: 6px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --mer-paper: #0E1726; --mer-surface: #15213A; --mer-ink: #E6EDF7;
    --mer-ink-muted: #A3B2C7; --mer-rule: #2A3A55; --mer-control-border: #7C8DA6;
    --mer-yes: #7FAEF5;
    --mer-on-yes: #0E1726; --mer-on-no: #0E1726;
    --mer-no: #F2A766; --mer-gain: #5CC98D; --mer-loss: #F28B82;
    --mer-warn: #E8C26A; --mer-focus: #7FAEF5;
  }
}
```
Solid YES and NO fills (the Settled badges) take their text from `--mer-on-yes` and `--mer-on-no`, never from white or `--mer-ink` by default: dark-mode white on `--mer-yes` is only 2.3:1, while `--mer-on-yes` (#0E1726) gives 7.9:1 and `--mer-on-no` 9.0:1. UI-02 AC2 tests those pairs too. Interactive controls (inputs, buttons, the four-intent segmented control, the wallet button) draw their boundary with `--mer-control-border`, never `--mer-rule`, so they meet the 3:1 non-text contrast of WCAG 1.4.11. `--mer-rule` is for decorative dividers and ladder rails only. Contrast values above are targets; UI-02 verifies each pair with an automated contrast test and adjusts hex values if any pair is below WCAG AA.

Principle: spend the boldness in one place. The **strike ladder** is the memorable element (a vertical ladder per ticker with a horizontal probability bar per strike and the live price drawn as a line between strikes). Everything else stays quiet: no gradients, no card shadows, one radius, rules instead of boxes where possible.

## 5. Before and after

### Markets
Before (M1-12): a header with "Meridian", balance, wallet; per ticker a plain table of Strike · Date · Status · Pairs outstanding. No price, YES/NO, probability, countdown or as-of.

After:
```
┌ Meridian  Markets Portfolio History Status        14:52:07 ET · close in 1:07:53 ┐
│                                                        Balance 1,250.00 test-USDC [Connect]│
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Will a MAG7 stock close at or above a price today? Pick a strike; YES wins at or above,│  ← landing (FR-21), 2 lines,
│ NO wins below. Max loss is what you pay. Connecting costs nothing and moves no funds;   │
│ each trade asks for one signature.                                      [Connect wallet]│    hidden once connected
├ NVDA  $181.42  as of 14:52:05 ET                                7 strikes · closes 16:00 ET ┤
│  $180  ▏██████████████████        58¢ YES   42¢ NO   58%   Open             [Trade]     │  ← whole row is the link
│ ─────── live $181.42 ───────────────────────────────────────────────                    │  ← live-price marker
│  $190  ▏██████                    18¢ YES   82¢ NO   18%   Open                         │
│  $200  ▏██                         4¢ YES   96¢ NO    4%   Open                         │
│  ...                                                                                    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```
Strikes are listed ascending (UI-03 AC1). The ticker header shows no day-change percentage: it needs a previous close or open price that is neither on-chain nor read by M1-12, and money math here is integer cents only. A later M2/M3 data ticket may add it from a supplied reference price, computed in integer basis points. Annotations: (a) the ladder bar length = YES price, labelled with the number; when YES is a bid and ask range (spread over 10¢ or a missing side) there is no filled bar: an outlined segment spans the bid to the ask length with the range text, and the NO column shows the derived NO range; (b) the live-price line sits between the two strikes it falls between; (c) each row links to Trade (2 clicks from landing: ticker row → strike row); the link is an anchor in the strike cell stretched over the row (a `tr` cannot be an anchor), pointing at `/trade/{market address}`, and is rendered only once the Trade route exists (UI-04 AC8 passes the `tradeHref` function that builds `/trade/{market address}`), so the demo has no dead link: the `[Trade]` text in the mockup above appears only then; (d) state badge text per §3; (e) 390 px: the bar collapses under the strike and the NO column hides behind a "YES/NO" toggle. (g) the YES figure follows the displayed-price rule in §3 (midpoint, or a bid and ask range with "wide spread" when the spread is over 10¢ or a side is missing; R-P1, [A4](design-research.md#8-adopt)), and a row's detail repeats "YES + NO = 100¢" (A7). (f) the ladder is a semantic table: one `row` per strike under a `region` per ticker, and the pairs outstanding count from M1-12 stays as a muted figure on each row (behind the same toggle at 390 px), so the M1-12 tests map onto it one-to-one: the ticker `h2` holds only the symbol (price, as-of and the strike count sit in sibling elements of the header line), there is exactly one header row, and the live-price marker is a decorative `aria-hidden` element, never a table row.

### Trade
Before: does not exist (M2).
After:
```
Will NVDA close at or above $180.00 at today's 16:00 ET close?   Open · closes in 1:07:53 · NVDA $181.42 as of 14:52:05 ET
Settles on the average of two official closing prices (Tiingo, Twelve Data) for 2026-10-08. YES wins at or above $180.00.
Trading stops 16:00 ET · Settlement about 16:05 ET · Redeem after settlement
┌ Book  [YES view | NO view]       ┐ ┌ [Buy YES][Buy NO][Sell YES][Sell NO]                      ┐
│ asks  61¢ ×40   60¢ ×25           │ │ Market ○ Limit ●  Price 40¢ NO   Qty [ 10 ]               │
│ ─── spread 2¢ · mid 59¢ ───       │ │ You pay $4.00 for 10 contracts. You win $10.00             │
│ bids  58¢ ×30   57¢ ×50           │ │ (profit $6.00) if NVDA closes below $180. Max loss $4.00. │
└───────────────────────────────────┘ │ You pay $4.00 · Pays if right $10.00 · Profit if right    │
  NO 40¢ = 100 − 60 YES; YES + NO =     │ $6.00 · Fees $0.00 (network fee in devnet SOL)            │
  100¢. (M3) Fair 58¢ · Edge +0¢        │ Simulated: rests YES ask at 60¢. 1 signature.             │
                                       │ [ Sign and buy NO ]   status: Simulating…                  │
                                       └───────────────────────────────────────────────────────────┘
```
Annotations: (a) the question is the H1; (b) the NO view relabels the same book (YES asks become NO bids at 100 − p), with a caption saying so; (c) the payoff sentence sits directly above the button; (d) one sign button, disabled until simulation passes; (e) 390 px: the panel stacks above the book; (f) the cost strip repeats the sentence's figures as four labelled values plus fees (A1, A10); (g) the settlement rule and the timeline strip sit under the question (A3); (h) the spread line also names the midpoint (A4) and the caption states NO is derived (A7).

### Portfolio
Before: does not exist (M2).
After:
```
test-USDC 1,250.00 · Redeemable now $40.00 [Redeem all] · Unrealized +$0.20 · Realized −$1.20
[Open] [Resting orders] [Closed]                                 Mark = book midpoint, not a guaranteed sale price
Market            Side  Qty  Avg   Mark  If right pays  Unrealized  Realized  State
NVDA ≥ $180 10/08  NO    10  42¢   44¢   $10.00         +$0.20      $0.00     Open · 1:07:53
AAPL ≥ $230 10/07  YES   40  55¢   100¢  $40.00         —           —         Settled YES at $231.02 [Redeem $40.00]
MM exposure: NVDA $180 net −10 YES-equiv · $190 +25 · ...   Open orders 3 · Unsettled $12.40 [Withdraw]
```
Figures are illustrative; the totals include positions not shown. Annotations: (a) the totals line answers "where do I stand" first; (b) settled winners show the payout and a one-click Redeem (US-11); (c) the MM block is dense and tabular (P3), collapsed for wallets with no open orders.

## 6. Accessibility and layout floor (all UI tickets)
- Works at 1280 px and 390 px; no horizontal scroll at 390 px except the book table.
- Keyboard: every action reachable by Tab, visible 2 px focus ring (`--mer-focus`), Enter/Space activate, Esc closes popovers.
- Every coloured state has a text label (§3). WCAG AA contrast for all token pairs.
- Lighthouse accessibility ≥ 90 on Markets and Trade (NFR-16), measured by a one-off `npx lighthouse` run that adds no dependency (see "Tooling for UI checks" in docs/tickets/M1.md).
- `prefers-reduced-motion`: no animated bars or countdown ticks beyond the text update.
- No `dangerouslySetInnerHTML` on external data; no server secrets in client bundles (M1-12 AC3 test keeps passing).

## Open questions
- v2 research gaps (see [design-research.md §6](design-research.md#6-gaps)): no CME ladder page and no live trading screen of Kalshi, Polymarket, Robinhood or IBKR could be fetched, so v2 takes layout cues from help text and tutorials only. A human review of the live screens (screenshots taken by the operator) could confirm or overturn the display choices (for example whether a ladder row shows both prices) before UI-03 and UI-04 are implemented.
- The cost strip and the average-fill line (A1, A2) read the simulation result and a volume-weighted average the M2 Trade ticket does not compute today; UI-04 AC9 asks for them, and if the simulation result does not carry the fill levels, the line falls back to the single price already in v1.
- Pre-open (also OQ-14 in docs/status.md): the program does not gate on 09:30 ET (see "Pre-open" under §3), so the UI shows `Open` from creation. Paawan to confirm that is intended; if a 09:30 gate is wanted it is an on-chain change (an `open_ts` on `Market`) and its own ticket, after which this table gains an "Opens 09:30 ET" state (mint only).
- Decided here, for Paawan to confirm (also OQ-15 in docs/status.md): the UI-02 exception of five display-only helpers in `units.ts` (`scaledToCentsFloor`, `formatUsdCents`, `formatUsdcBalance`, `formatPriceTenths`, `formatUsdSigned`; see "Settle price display", "Money strings" and "Fractional cents"). The alternative is to hold the settled-price text until a separate client ticket lands.
- None conflict with brief.md, requirements.md or a By: human decision. A web font (for example a tabular-figure sans) would improve the ladder; it is not proposed because a new font is a Tier 2 dependency. Recommendation: keep system stacks.
