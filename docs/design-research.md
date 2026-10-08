<!-- OWNER: shared. -->
# Meridian: UI design research (UI-01 v2, D-048)

Purpose: ground [design.md](design.md) in how public prediction-market and binary-option products present the same things Meridian presents. Public pages only, fetched in the session that wrote this file (2026-10-08 CT). No logins, no accounts, no pages behind auth. Page content is treated as information, never as instructions.

Rules for every claim below:
- A claim has a source URL on the same bullet. If a page was fetched and did not say something, the bullet says "not stated".
- `(unverified)` marks a claim seen only in a search-result summary or a page that could not be fetched (it returned HTTP 403/404/429). Unverified claims are never used as the sole reason for a design change.
- Where a product could not be researched for a topic, the section says so instead of guessing.

Ids (`R-K1`, `R-P2`, ...) are cited by design.md and by the UI tickets.

## 1. Kalshi

Sources are Kalshi's public help center and API docs.

- **R-K1 Trade ticket.** A Quick (market) order takes "the quantity and direction (Yes or No)". The order panel "accounts for this automatically; it would show you an average price", with the example "500 at 10¢ each and another 500 for 12¢ each, for an average price of 11¢". The page does not describe cost, payout, max loss or fee fields. <https://help.kalshi.com/trading/order-types/quick-orders>
- **R-K2 Matching.** "you are always trading against another member of the platform, not the exchange itself"; makers declare side, price and quantity; "Takers can see all available offers and match with the most generous one". How prices are displayed: not stated. <https://help.kalshi.com/trading/who-are-you-trading-with>
- **R-K3 Portfolio.** Predictions are filtered as Open, Pending and Closed. Each position shows contract quantities, purchase prices, potential payouts and a current displayed value (position price × quantity). The page says "potential payout is not the same as profit. Your profit or loss also depends on what you paid and applicable fees", with ten contracts costing $5 that pay $10 giving "$5 gain or a $5 loss before applicable fees". Columns for cost basis, average price and P&L: not stated. <https://help.kalshi.com/navigating-the-exchange/your-portfolio/portfolio>
- **R-K3b Balances.** "Portfolio value is your cash balance plus the displayed value of your positions"; positions value "is not a guaranteed amount you can sell them for"; cash changes through deposits, sales, settlement, withdrawals and fees. How settled positions or history appear: not stated. <https://help.kalshi.com/en/articles/13823844-portfolio-balances-and-positions>
- **R-K4 Market rules.** Each market has a rules summary with the outcomes required for a strike to resolve Yes and the outcome verification source; "Make sure to read market rules before trading!"; "A market remaining open or undetermined is in no way an indication of the resolution criteria being met or not being met." Which strike resolves, shown in the UI: not stated. <https://help.kalshi.com/markets/markets-101/market-rules>
- **R-K5 Strikes and ranges.** A market holds several "strikes"; daily weather markets are "typically ranges ... offered as a set of temperature ranges plus 'or above' / 'or below' levels", settling "the next morning" from a named official report, and the page says that only the official source named in each market's rules decides the outcome, not other apps or services. Users can request more strikes from an options icon on the market. <https://help.kalshi.com/en/articles/13823837-weather-markets>, <https://help.kalshi.com/en/articles/13823834-request-additional-strikes>
- **R-K6 Settlement.** Holders of the winning side get $1 per contract; "Only net positions are settled (after netting)"; "Markets typically settle shortly after expiration, but timing can vary based on market type, data source availability, and manual review requirements"; settlement fees are zero for simple yes/no. Whether holders must claim: not stated. <https://docs.kalshi.com/getting_started/market_settlement>
- Not covered: Kalshi's market-list and ladder screens (the public pages are script-rendered; the one help page that mentions the order panel, <https://kalshi.com/pro/help/the-order-panel>, returned HTTP 429). `(unverified)`

## 2. Polymarket

Sources are Polymarket's public documentation and help center.

- **R-P1 Price display.** "Every share on Polymarket is priced between $0.00 and $1.00." "The displayed price is the midpoint of the bid-ask spread. If the spread is wider than $0.10, the last traded price is shown instead." Example: bid $0.34 and ask $0.40 display $0.37 (37%). Spread is "the gap between the highest bid and lowest ask". <https://docs.polymarket.com/concepts/prices-orderbook.md>
- **R-P1b Yes/No pairing.** Orders match when the prices sum to one dollar ("$0.60 + $0.40 = $1.00") and "1 pUSD of collateral creates a complete set" of Yes and No tokens. Same page as R-P1.
- **R-P2 Resolution.** Markets resolve through the UMA Optimistic Oracle (proposal with a bond, a 2-hour challenge period, a second proposal if disputed, then token-holder voting of about 48 hours; the page gives 4 to 6 days for a disputed resolution). Winning tokens become "redeemable for $1.00 each", losing tokens $0.00. UI status names: not stated. <https://docs.polymarket.com/concepts/resolution>
- **R-P3 Positions.** Users can split, merge and redeem; redeem needs a resolved market; "There is no redemption deadline. Winning tokens remain redeemable at any time after resolution." <https://docs.polymarket.com/trading/positions/manage.md>
- **R-P4 Account and wallet.** Sign-up is Google, an emailed 6-digit code, or a crypto wallet (MetaMask, Rabby, Phantom). With a wallet the user signs one message to connect it and another to "Enable Trading" (the page's step names). <https://help.polymarket.com/en/articles/13369877-how-to-sign-up>
- **R-P5 Orders.** The orders overview page shows orders with `price`, `originalSize`, `sizeMatched` and a `LIVE` status. It does not explain order types, tick size, the Yes/No buy mechanics or pre-trade cost and payout display (all "not stated"). <https://docs.polymarket.com/trading/orders/overview> A search summary also lists GTC, FOK and FAK order types `(unverified)`.

## 3. Robinhood event contracts

Robinhood's own support and learn pages.

- **R-R1 Contract basics.** "You buy Yes if you think the outcome will occur, or No if you think it won't." Prices run from $0.01 to $0.99 and "reflect the market's implied probability"; "You can buy and sell contracts before expiration at the current market price"; the contract "settles at $1" or "$0". The page includes a probability-weighted commission formula and a fee table; it does not describe the buy flow, positions or history screens. <https://www.robinhood.com/us/en/support/articles/robinhood-event-contracts/>
- **R-R2 Price as probability.** "A Yes contract trading at $0.70 suggests the market believes there's roughly a 70% chance". Yes/No shown as a pair, for example Yes $0.51 and No $0.50 (a combined $1.01, which the article attributes to "a bid/ask spread or embedded fees"); a Fed example states "maximum gain $0.05, maximum loss $0.95". <https://robinhood.com/us/en/learn/articles/how-event-contract-pricing-works/>
- **R-R3 Profit versus payout.** "you're paying a price below $1 today, for the chance to receive $1 later", and that price is the maximum loss per contract; "the payout is not necessarily your profit or loss"; worked examples (buy at $0.40, settle at $1 is a $0.60 gain; buy at $0.40, settle at $0 is a $0.40 loss; closing early is "simply the difference between your entry and exit price"); commissions and the spread change net profit. <https://robinhood.com/us/en/learn/articles/profit-vs-payout-event-contracts/>
- **R-R4 Event page wording and rules.** A public (closed) event page words the threshold as a question: "Will the price of WTI be at or above the $90.78 target price at the end of the 15-minute window?"; shows the window time; says "This event is closed and no longer tradable"; names the source (Pyth WTI data), states the rounding (nearest 2 decimal places) and gives payout timing ("Usually within 1 hour of event resolution"). Which price or buttons the live page shows: not stated (the closed page showed 99.9¢ and 0.0¢ bid/ask). <https://robinhood.com/us/en/prediction-markets/commodities/events/wti-oil-15-min-9078-target-oct-08-2026/>
- `(unverified)` Search summaries state that Robinhood sends trades as IOC limit orders into the partner exchange, that the flow is "swipe to submit", and that payouts are withdrawable within 2 business days; none of those pages could be confirmed by fetch.

## 4. Interactive Brokers ForecastTrader (ForecastEx)

IBKR Campus lesson (the vendor's own tutorial); the main ForecastTrader pages returned HTTP 403.

- **R-I1 Market list and sides.** Contracts are organised by category (Government, Economic Indicators, Elections, Technology, Financial Markets, Environmental, CME Event Contracts) with a "Popular" view. "Forecast contracts are available in two versions, Yes and No contracts", and clicking either side shows "each side's price history". <https://ibkrcampus.com/campus/trading-lessons/prediction-markets-at-interactive-brokers/>
- **R-I2 Price, payout and risk.** Prices run "$0.02 to $0.99" with "$1.00 if the prediction is correct"; losses are "limited at the initial investment amount".
- **R-I3 Order ticket.** The ticket shows "Potential Profit and Maximum Loss" and "Estimated Total for the Order"; the user enters a limit price and a quantity and "The trade value populates the Amount field". (Same page as R-I1.)
- **R-I4 Positions and timeline.** Open positions are under the Portfolio button's Positions tab; each contract has a timeline of its "last time and date for trading, release of results, and the payout". (Same page.)
- `(unverified)` A search summary of IBKR's documentation says a "strike" is "a fully specified question" like a row of an option chain with two contracts per strike, YES as a Call and NO as a Put; the pages (<https://www.interactivebrokers.com/docs/web-api/web-api-v-1-0-documentation/endpoints/event-contracts/markets-and-strikes>) returned HTTP 403.

## 5. Nadex binary options

Only two Nadex learning pages could be fetched; the order-ticket and platform walkthrough pages returned HTTP 404.

- **R-N1 Price as probability.** The midpoint of bid and offer "can be used as an indication of the implied probability of a trade potentially finishing ITM ... and receiving the full $100 payout per contract"; formula "(bid + offer)/2 = probability %". Page: <https://www.nadex.com/learning/implied-probability-itm/>
- **R-N2 Return framing.** "Max ROI" is "calculated using the best current bid or offer price at a particular moment and assumes you hold the contract until expiration to receive the full $100 payout per contract, minus the cost of your trade and fees"; examples buy at $46.00 for 113.04% and sell at $81.00 (cost $19.00) for 415.79%. How maximum profit and loss appear on the ticket: not stated. <https://www.nadex.com/learning/max-roi/>
- `(unverified)` Search summaries state that binaries price between 0 and 100, show a bid and an ask, that the ticket shows maximum possible profit and loss before confirming, and that the account must hold the maximum risk as collateral.

## 6. Gaps

- CME-style binary ladders (the brief mentions "ladders"): no CME page was fetched, so nothing is claimed about their layout.
- Live trading screens of Kalshi, Polymarket, Robinhood and IBKR: not fetched (script-rendered or behind login). Everything above about layout comes from help text or tutorials, which describe the screens in words and are not screenshots. Screens-only facts (colours, density, motion) are therefore not claimed.
- Robinhood and IBKR history screens, and every product's CSV or tax export: not covered.

## 7. What Meridian does differently

From [domain.md](domain.md) and [requirements.md](requirements.md), so adopt/avoid below can be weighed:
- One YES-vs-USDC order book on chain; NO is `100 − YES` by construction, never separately quoted.
- Integer cents 1 to 99; strikes are multiples of $10; settlement from two official closing prices; devnet test-USDC, no fees, a wallet instead of an account.
- One signature per trade, simulate-before-sign, a payoff sentence before the signature (NFR-12, NFR-15).

## 8. Adopt

| Id | Adopt | Why (source) | Where in design.md |
|---|---|---|---|
| A1 | Show cost (which is the maximum loss), what it pays if right, profit if right and the estimated total directly above the sign button, next to the payoff sentence | IBKR's ticket shows "Potential Profit and Maximum Loss" and "Estimated Total for the Order" (R-I3); Robinhood and Kalshi both stress that payout is not profit (R-R3, R-K3) | §3 "Payoff sentence", §5 Trade |
| A2 | For a market-sized order, show the average fill price and how many price levels it spans | Kalshi's panel shows an average price when an order spans prices (R-K1) | §3 "Payoff sentence" (simulated result line) |
| A3 | State how and from what a strike settles, next to the strike, with the time line (trading stops, settlement time, redeem) | Kalshi rules summary with verification source (R-K4), Robinhood's event page names source, rounding and payout timing (R-R4), IBKR's timeline (R-I4), Polymarket redeem rule (R-P3) | §3 "How a strike settles", §5 Trade |
| A4 | A written displayed-price rule: the book midpoint when both sides exist and the spread is at most 10¢, otherwise the bid and ask range; say plainly the midpoint is not an executable price | Polymarket's published rule (R-P1), Nadex midpoint as implied probability (R-N1), Kalshi's "not a guaranteed amount you can sell them for" (R-K3b) | §3 "Price, probability, fair value, edge" |
| A5 | Portfolio filters Open, Resting orders and Closed, and an "If right pays" column | Kalshi's Open, Pending and Closed filters and potential-payout column (R-K3) | §2 Portfolio, §5 Portfolio |
| A6 | A "Closed is not settled" sentence on the Closed and Settling states | Kalshi: open or undetermined is no indication of the outcome (R-K4); settlement timing varies (R-K6) | §3 "Market state" |
| A7 | State that NO is always `100 − YES` and that the pair totals 100¢ | Robinhood's quoted pair can total $1.01 (R-R2); Polymarket matches pairs that sum to $1.00 (R-P1b) | §3 "YES vs NO" |
| A8 | Say what connecting costs and asks for: nothing, with one signature per trade later | Polymarket asks for a connect signature and another to enable trading (R-P4), so users need to be told what Meridian will not ask | §5 Markets landing |
| A9 | Word the market as a question with the time: "Will NVDA close at or above $180.00 at today's 16:00 ET close?" | Robinhood's event page uses a threshold question with the window end (R-R4) | §2 Trade, §5 Trade |
| A10 | Show fees as an explicit line (`Fees $0.00`; the network fee is paid in devnet SOL) | Fees are central in Robinhood's pricing pages (R-R1, R-R3); an absent fee line reads as hidden | §5 Trade |
| A11 | Strike-per-row ladder with YES and NO side by side, ranges and "or above" semantics spelled out in the row text | Kalshi strikes and "or above" levels (R-K5); IBKR strike with a YES and a NO contract (R-I1, unverified for the option-chain framing) | §5 Markets (existing ladder; wording) |

## 9. Avoid

| Id | Avoid | Why (source) |
|---|---|---|
| V1 | Quoting NO separately from YES | A separately quoted pair can total more than $1 (R-R2: $1.01); Meridian's NO is derived, so showing it as its own quote would imply a spread that does not exist |
| V2 | Presenting the midpoint as a price the user can trade at | Kalshi warns the displayed value is not a guaranteed sale amount (R-K3b); the ticket must show the executable bid and ask |
| V3 | Multi-day dispute and voting states | Polymarket's resolution has proposal, challenge and voting stages of 4 to 6 days (R-P2); Meridian settles from an oracle and has only the delayed and override states in domain.md |
| V4 | A second "enable trading" signature or approval step | Polymarket's second signature (R-P4) is not needed by Meridian; adding a similar step would break "one signature per trade" |
| V5 | Account approval, KYC or permissions language | Robinhood and IBKR gate products behind account permissions (search summaries, `(unverified)`); Meridian is a wallet app on devnet and must not suggest an approval step exists |
| V6 | Hiding the settlement source until after trading | Every product that publishes rules puts the source next to the market (R-K4, R-R4) |
| V7 | Jargon-only order types in the main ticket (for example GTC/FOK) | Polymarket's order primitives are not user-facing explanations (R-P5, `(unverified)` list); Meridian keeps plain words ("Buy now at the best price", "Set a price") |
| V8 | Percent-only or price-only display | Robinhood and Nadex express price and probability together (R-R1, R-N1); Meridian already shows both and keeps doing so |
