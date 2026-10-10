# Pyth test fixtures

## lazer_<ticker>_close_2026-10-09.json (real, signed by Pyth)

The update Pyth Lazer (Pyth Pro) signed at the close of Friday 2026-10-09, 16:00:00 ET
(`close_ts` 1791576000), for each MAG7 ticker. Recorded 2026-10-10 with
`pnpm --filter e2e pyth-record <TICKER> 2026-10-09` (`POST https://pyth-lazer.dourolabs.app/v1/price`,
formats `[solana]`, channel `fixed_rate@200ms`, properties price / exponent / confidence). The
token is never stored.

- `solanaHex`: the SolanaMessage exactly as served: magic, Ed25519 signature, signer public key
  (`9gKEEcFzSd1PDYBKWAKZi4Sq4ZCUaVX5oTr8kEjdwsfR`, D-056), payload length, payload.
- The other fields are decoded copies for reading: `timestampUs` equals the requested close,
  `price` / `exponent` / `confidence` are mantissas, `priceCents` and `confidenceBps` derived.

| Ticker | Feed | Close | Confidence |
|---|---|---|---|
| AAPL | 922 | $336.51 | 2.49 bps |
| AMZN | 954 | $262.43 | 1.50 bps |
| GOOGL | 1163 | $351.60 | 1.69 bps |
| META | 1272 | $718.38 | 2.89 bps |
| MSFT | 1292 | $535.08 | 1.16 bps |
| NVDA | 1314 | $229.34 | 2.50 bps |
| TSLA | 1435 | $382.76 | 1.40 bps |

Used by `programs/meridian/tests/pyth_recorded.rs`, `tests/security/program/tests/ab_04_pyth_spoofed_update.rs`
and `services/automation/src/pythLazer.test.ts`.

## Pyth PriceUpdateV2 (Pyth Core receiver, synthetic; not used by the Lazer path)

These fixtures are manually constructed PriceUpdateV2 accounts matching the pyth-solana-receiver-sdk layout for testing the Pyth parser (M3-10).

### price_update_v2_aapl.json

Synthetic PriceUpdateV2 account with known values for testing `parse_pyth_price`.

**Created**: 2026-10-09  
**Source**: Manually constructed to match SDK layout  
**Owner**: rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ (Pyth Solana Receiver program)

#### Account Structure (133 bytes total, Full VerificationLevel):
- **Discriminator** (8 bytes): `[34, 241, 35, 99, 157, 126, 244, 205]` (Anchor sha256("account:PriceUpdateV2")[:8])
- **write_authority** (32 bytes): `0xaa...aa` (dummy pubkey)
- **VerificationLevel** (1 byte): `Full` (tag=1)
- **PriceFeedMessage** (84 bytes, SDK layout):
  - **feed_id**: `0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688` (AAPL)
  - **price**: `15000` (i64)
  - **conf**: `5` (u64)
  - **exponent**: `-2` (i32)
  - **publish_time**: `1791316801` (i64, Unix timestamp)
  - **prev_publish_time**: `1791316800` (i64)
  - **ema_price**: `14990` (i64)
  - **ema_conf**: `10` (u64)
- **posted_slot**: `412345678` (u64, 8 bytes)

#### Expected Parsed Values:
- **feed_id**: AAPL feed ID bytes
- **value_scaled**: `150_000_000_000_000_000_000` (15000 * 10^(-2) scaled to 18 decimals = 150.00 * 10^18)
- **publish_time**: `1791316801`
- **confidence**: `5`
- **posted_slot**: `412345678`

This fixture exercises:
- VerificationLevel::Full (1 byte) branch
- Positive price scaling with negative exponent
- All field parsing in correct byte order
