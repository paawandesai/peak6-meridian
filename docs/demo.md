<!-- OWNER: operator. -->
# Demo Walkthrough

This walkthrough demonstrates the four core trade intents on Meridian: buying YES, buying NO, selling YES, and selling NO.

## Prerequisites

Start the local environment:
```bash
make dev  # validator :8899 + app :3000
```

## 1. Markets View

The home page shows all available binary outcome markets for today's trading session.

**Mobile (390px):**
![Markets Mobile](/uploads/5442898fb6c8d1ad2da9b62bb0b4e12d/01-markets-mobile.png)

**Desktop (1280x720):**
![Markets Desktop](/uploads/cab19f67af7d339a369d5ea7d4d8f5bf/01-markets-desktop.png)

Each market displays:
- Ticker symbol (e.g., AAPL, MSFT)
- Strike price
- Current YES/NO prices
- Time until market close (4:00 PM ET)

## 2. Trade View

Clicking a market opens the trade interface where you can buy or sell YES/NO contracts.

**Mobile:**
![Trade Mobile](/uploads/2791cd38842667a10b31133863951907/02-trade-mobile.png)

**Desktop:**
![Trade Desktop](/uploads/967a5f84d1cc5a3a677405cc40a160fb/02-trade-desktop.png)

### Trade Intent 1: Buy YES
1. Select YES side
2. Enter quantity (e.g., 10 contracts)
3. Review price (shown in cents per contract)
4. Click "Buy YES"
5. Confirm transaction in wallet
6. Outcome: You receive 10 YES tokens in your portfolio

### Trade Intent 2: Buy NO
1. Select NO side  
2. Enter quantity
3. Review price
4. Click "Buy NO"
5. Confirm transaction
6. Outcome: You receive NO tokens

### Trade Intent 3: Sell YES
1. Must own YES tokens first (via Buy YES or Mint Pair)
2. Select YES side, choose "Sell"
3. Enter quantity to sell
4. Review proceeds
5. Click "Sell YES"
6. Confirm transaction
7. Outcome: YES tokens burned, USDC proceeds credited

### Trade Intent 4: Sell NO
1. Must own NO tokens first
2. Select NO side, choose "Sell"
3. Enter quantity
4. Review proceeds
5. Click "Sell NO"
6. Confirm transaction
7. Outcome: NO tokens burned, USDC proceeds credited

## 3. Portfolio View

Shows your current holdings across all markets.

**Mobile:**
![Portfolio Mobile](/uploads/0106da6b7efd473fee4e3654b18a5cc9/03-portfolio-mobile.png)

**Desktop:**
![Portfolio Desktop](/uploads/acf816fad1daa88877103ccd016eca54/03-portfolio-desktop.png)

Displays:
- YES/NO token balances per market
- Current position value
- Unrealized P&L based on current market prices
- Available USDC balance

## 4. History View

Transaction history showing all your trades, mints, and redemptions.

**Mobile:**
![History Mobile](/uploads/b7ad2036c5ce8d3c822a3b8c3e9dff9c/04-history-mobile.png)

**Desktop:**
![History Desktop](/uploads/18724059989e703da07272bb281d3698/04-history-desktop.png)

Each entry shows:
- Transaction type (Buy, Sell, Mint, Redeem)
- Market ticker and strike
- Quantity and price
- Timestamp
- Transaction signature (link to Solana Explorer)

## 5. Faucet (Admin)

Test-USDC faucet for funding wallets on devnet.

**Mobile:**
![Faucet Mobile](/uploads/7448187fd2b13b307b83e8349495ba2e/05-faucet-mobile.png)

**Desktop:**
![Faucet Desktop](/uploads/1820bc2cdd4d0a75dd42faefab65281a/05-faucet-desktop.png)

- Connect wallet
- Click "Request Test USDC"
- Receive 100 test-USDC for trading
- Use only on devnet/localnet

## 6. Status Page

System health and market statistics.

**Mobile:**
![Status Mobile](/uploads/da7dad1b2880aacef601c60b2342806d/06-status-mobile.png)

**Desktop:**
![Status Desktop](/uploads/c24454b1e9e9f35801e45d2ce2e0141c/06-status-desktop.png)

Shows:
- Validator connection status
- Program deployment info
- Active markets count
- 24h trading volume
- Last oracle update timestamp

## Settlement and Redemption

After 4:00 PM ET close:
1. Oracle fetches closing prices from Tiingo
2. Markets settle (YES wins if close ≥ strike, else NO wins)
3. Winners can redeem tokens for $1.00 USDC each
4. Losers' tokens have zero value

See [docs/domain.md](domain.md) for full trading rules and settlement mechanics.

## Video

_Video walkthrough to be added in M4-05._
