# RedStone Fixtures: 2024-10-01

**Status:** PLACEHOLDER - Real fixtures need to be recorded manually  
**Close time:** 2024-10-01T21:00:00.000Z (4:00 PM ET)  
**Tickers:** AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA  
**Gateways:** 2 (byte-identical verification required)

## Recording Real Fixtures

To record real RedStone packages for this date, run:

```bash
pnpm exec tsx scripts/redstone/record-fixture.ts --date 2024-10-01
```

With official closes (optional):

```bash
pnpm exec tsx scripts/redstone/record-fixture.ts --date 2024-10-01 \
  --tiingo-key $TIINGO_API_KEY \
  --twelvedata-key $TWELVEDATA_API_KEY
```

## Expected Files

- `AAPL.json`: RedStone signed package for AAPL
- `MSFT.json`: RedStone signed package for MSFT
- `GOOGL.json`: RedStone signed package for GOOGL
- `AMZN.json`: RedStone signed package for AMZN
- `NVDA.json`: RedStone signed package for NVDA
- `META.json`: RedStone signed package for META
- `TSLA.json`: RedStone signed package for TSLA
- `official-closes.json`: Tiingo/Twelve Data official closes (if API keys provided)

## Provenance

- **Source:** RedStone Primary Prod (`redstone-primary-prod`)
- **Gateways:**
  1. https://api.redstone.finance
  2. https://api-primary-prod.redstone.finance
- **Verification:** Packages must be byte-identical across both gateways

## Usage

These fixtures are used by:
- `programs/meridian/tests/redstone_fixture.rs`: Signature verification with threshold 3
- `tests/security/ts/ab_03_stale_or_wrong_date.test.ts`: Stale package rejection
- `tests/security/ts/ab_04_spoofed_feed.test.ts`: Tampered/spoofed package rejection
- `tests/security/ts/ab_05_settle_before_close.test.ts`: Settlement timing
- `tests/security/ts/ab_13_feed_spread.test.ts`: Oracle vs official close spread check

Public data only (no API keys, no secrets).
