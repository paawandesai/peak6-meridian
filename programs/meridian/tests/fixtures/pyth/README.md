# Pyth PriceUpdateV2 Test Fixtures

These fixtures are manually constructed PriceUpdateV2 accounts matching the pyth-solana-receiver-sdk layout for testing the Pyth parser (M3-10).

## price_update_v2_aapl.json

Synthetic PriceUpdateV2 account with known values for testing `parse_pyth_price`.

**Created**: 2026-10-09  
**Source**: Manually constructed to match SDK layout  
**Owner**: rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ (Pyth Solana Receiver program)

### Account Structure (109 bytes total):
- **Discriminator** (8 bytes): `[34, 241, 35, 99, 157, 126, 244, 205]` (Anchor sha256("account:PriceUpdateV2")[:8])
- **write_authority** (32 bytes): `0xaa...aa` (dummy pubkey)
- **VerificationLevel** (1 byte): `Full` (tag=1)
- **PriceFeedMessage** (68 bytes):
  - **feed_id**: `0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688` (AAPL from feed_ids)
  - **price**: `15000` (i64)
  - **conf**: `5` (u64)
  - **expo**: `-2` (i32)
  - **publish_time**: `1791316801` (i64, Unix timestamp)
  - **posted_slot**: `412345678` (u64)

### Expected Parsed Values:
- **feed_id**: AAPL feed ID bytes
- **value_scaled**: `150_000_000_000_000_000_000` (15000 * 10^(-2) scaled to 18 decimals = 150.00 * 10^18)
- **publish_time**: `1791316801`
- **confidence**: `5`
- **posted_slot**: `412345678`

This fixture exercises:
- VerificationLevel::Full (1 byte) branch
- Positive price scaling with negative exponent
- All field parsing in correct byte order
