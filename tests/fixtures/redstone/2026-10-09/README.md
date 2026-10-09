# RedStone Fixtures: 2026-10-09

**Recorded:** 2026-10-09T16:01:30.000Z  
**Source:** RedStone Primary Prod (`redstone-primary-prod`)  
**Endpoint:** `https://api.redstone.finance/prices?symbol={ticker}&provider=redstone-primary-prod`  
**Tickers:** AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA

## Capture Details

These fixtures were captured from the live RedStone gateway on 2026-10-09 at 16:01:30 UTC.

**Common timestamp:** 1791561690000 (2026-10-09T16:01:30.000Z)

Each ticker file contains the RedStone price data structure:
- `symbol`: Ticker symbol
- `provider`: `redstone-primary-prod`
- `value`: Price value (floating point)
- `timestamp`: Package timestamp in milliseconds
- `source`: Empty object (metadata)
- `providerPublicKey`: Empty string (not included in /prices endpoint response)
- `permawebTx`: Mock permaweb transaction ID
- `version`: API version

## Test Usage

Tests can use these fixtures and adjust `close_ts` relative to the recorded timestamp:

- **Pass cases:** Set `close_ts = timestamp - 60_000` (60s before package)
- **Fail AB-03 (stale):** Set `close_ts = timestamp + 1000` (package before close)
- **Fail AB-03 (old slots):** Post package with `slot > max_staleness_slots` from current slot

## Files

- `AAPL.json`: Apple Inc.
- `MSFT.json`: Microsoft Corporation
- `GOOGL.json`: Alphabet Inc. (Google)
- `AMZN.json`: Amazon.com Inc.
- `NVDA.json`: NVIDIA Corporation
- `META.json`: Meta Platforms Inc.
- `TSLA.json`: Tesla Inc.

## Note on Signed Packages

The `/prices` endpoint returns price data without the full cryptographic signature structure. For tests requiring signature verification (M2-15 `post_redstone_price`), the actual signed data-package format from RedStone's SDK or alternative endpoint will be needed. These fixtures provide the price values and timestamps for initial test development.

Public data only (no API keys, no secrets).
