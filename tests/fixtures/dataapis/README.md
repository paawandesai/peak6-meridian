# Data API fixtures

Recorded-shape responses for Tiingo (`/tiingo/daily/<ticker>/prices`) and Twelve Data
(`/time_series?interval=1day`). Prices are synthetic. Tests read these files; no test calls a live API.

| File                                       | Scenario                                                             |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `tiingo_aapl_2026-10-05.json`              | Tiingo daily bar for AAPL on 2026-10-05, close 230.12                |
| `twelvedata_aapl_2026-10-05_agree.json`    | Twelve Data bars, 2026-10-05 close 230.15 (1.3 bps from Tiingo)      |
| `twelvedata_aapl_2026-10-05_disagree.json` | Twelve Data bars, 2026-10-05 close 230.30 (7.8 bps from Tiingo)      |
| `twelvedata_aapl_stale.json`               | Twelve Data bars whose latest date is 2026-10-02 (no 2026-10-05 bar) |
| `twelvedata_error_429.json`                | Twelve Data error body (out of API credits)                          |
| `tiingo_empty.json`                        | Tiingo returns no bar for the requested date                         |
| `tiingo_malformed.txt`                     | Truncated JSON body (`.txt` so Prettier does not parse it)           |
| `tiingo_bad_close.json`                    | Tiingo bar with a non-numeric close                                  |
