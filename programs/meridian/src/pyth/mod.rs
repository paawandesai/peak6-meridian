//! Pyth oracle adapter (D-055, M3-10): reads and validates Pyth Pro (Lazer) price feeds.
//! This module handles Pyth as the second on-chain price source alongside RedStone, restoring
//! the two-source spread check from D-033.
//!
//! Pyth Pro delivers signed price updates via REST API (PYTH_API_TOKEN); automation posts them
//! to Pyth's on-chain Solana Receiver program for verification. `settle_market` reads the
//! verified price from Pyth's price account.
//!
//! Checks for one feed (domain.md § Settlement rules, AB-03/AB-04): owner (Pyth program),
//! pinned feed ID, publish time at or after `close_ts`, staleness within `max_staleness_slots`.
//! A reading is trusted only after all checks pass.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::oracle::CloseReading;

/// Pyth program on mainnet-beta.
/// Source: https://docs.pyth.network/price-feeds/contract-addresses/solana
pub const PYTH_MAINNET_PID: Pubkey = pubkey!("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");

/// Pyth program on devnet.
/// Source: https://docs.pyth.network/price-feeds/contract-addresses/solana
pub const PYTH_DEVNET_PID: Pubkey = pubkey!("gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s");

/// Pyth Solana Receiver program on mainnet-beta (for Pyth Pro signed updates).
/// Source: https://docs.pyth.network/price-feeds/use-real-data/solana#price-feed-accounts
pub const PYTH_PUSH_MAINNET_PID: Pubkey =
    pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc6E6JiV");

/// Pyth Solana Receiver program on devnet (for Pyth Pro signed updates).
pub const PYTH_PUSH_DEVNET_PID: Pubkey = pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc6E6JiV");

/// Pyth feed IDs for MAG7 tickers (from issue #49).
/// These are the Pyth Pro feed IDs for equity tickers.
pub mod feed_ids {
    /// AAPL feed ID: 922 in Pyth Pro.
    pub const AAPL: &str =
        "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688";
    /// AMZN feed ID: 954 in Pyth Pro.
    pub const AMZN: &str =
        "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a";
    /// GOOGL feed ID: 1163 in Pyth Pro.
    pub const GOOGL: &str =
        "0x726c49cd73149a5eb8e5570d0e2cbf01c99853af3e5aeebd01e7eb6e1d15f977";
    /// META feed ID: 1272 in Pyth Pro.
    pub const META: &str =
        "0x4b78d251770732f6304b1f41e9bebaabc3b256985ef18988f6de8d6562dd254c";
    /// MSFT feed ID: 1292 in Pyth Pro.
    pub const MSFT: &str =
        "0x4f1b1a0e68b8f1b5e1573eeb95e5b99fda76098146c66c1e5d3e7f0c94bc2294";
    /// NVDA feed ID: 1314 in Pyth Pro.
    pub const NVDA: &str =
        "0x6fa7e48602d2e6c0f46c1f2ef3d9d4b16d67a7a72f000a83aee12cb4e5d1c7a6";
    /// TSLA feed ID: 1435 in Pyth Pro.
    pub const TSLA: &str =
        "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc9641f1";
}

/// Pyth price account discriminator (first 8 bytes).
/// Pyth uses a different account structure; this will be refined based on actual Pyth account layout.
pub const PYTH_PRICE_DISCRIMINATOR: [u8; 8] = [0; 8]; // TODO: Update with actual Pyth discriminator

/// One Pyth feed's reading, before settlement checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythReading {
    /// Pyth feed ID (32-byte identifier).
    pub feed_id: [u8; 32],
    /// Price value with Pyth's exponent applied (will be scaled to match our oracle value format).
    pub value_scaled: i128,
    /// Unix timestamp of the price update (publish_time).
    pub publish_time: i64,
    /// Confidence interval of the price.
    pub confidence: u64,
}

fn read_array<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N]> {
    let end = offset.checked_add(N).ok_or(MeridianError::MathOverflow)?;
    data.get(offset..end)
        .and_then(|bytes| <[u8; N]>::try_from(bytes).ok())
        .ok_or_else(|| MeridianError::OracleInvalidValue.into())
}

/// Parses a Pyth price account to extract the reading.
///
/// NOTE: This is a placeholder implementation. The actual Pyth price account layout
/// needs to be determined based on Pyth's on-chain account structure. This will be
/// refined once we have access to real Pyth price accounts on devnet.
pub fn parse_pyth_price(data: &[u8]) -> Result<PythReading> {
    // TODO: Implement actual Pyth price account parsing based on Pyth's account layout.
    // For now, this is a placeholder that will fail at runtime.
    // The actual implementation will:
    // 1. Check account discriminator
    // 2. Extract feed_id from the account
    // 3. Extract price, confidence, expo, publish_time
    // 4. Scale the price to our oracle value format (18 decimals to match Switchboard/RedStone)

    require!(data.len() >= 32, MeridianError::OracleInvalidValue);

    // Placeholder - will be replaced with actual parsing
    Err(MeridianError::OracleInvalidValue.into())
}

/// Validates a Pyth reading: pinned feed ID, positive value, published at or after close, fresh.
pub fn check_pyth_reading(
    reading: &PythReading,
    expected_feed_id: &[u8; 32],
    clock: &Clock,
    close_ts: i64,
    max_staleness_slots: u64,
) -> Result<CloseReading> {
    // Check 1: Feed ID must match expected
    require!(
        reading.feed_id == *expected_feed_id,
        MeridianError::OracleFeedHashMismatch
    );

    // Check 2: Value must be strictly positive
    require!(
        reading.value_scaled > 0,
        MeridianError::OracleInvalidValue
    );

    // Check 3: Publish time must be at or after close_ts (AB-03)
    require!(
        reading.publish_time >= close_ts,
        MeridianError::OracleBeforeClose
    );

    // Check 4: Staleness check
    // For Pyth, we need to convert publish_time to slots or check elapsed time
    // TODO: Determine how to properly check staleness for Pyth price updates
    // For now, we'll use a simple timestamp-based check
    let current_time = clock.unix_timestamp;
    let age_seconds = current_time
        .checked_sub(reading.publish_time)
        .ok_or(MeridianError::OracleInvalidValue)?;

    // Convert slots to approximate seconds (assuming ~400ms per slot)
    let max_age_seconds = i64::from(max_staleness_slots)
        .checked_mul(400)
        .and_then(|ms| ms.checked_div(1000))
        .ok_or(MeridianError::MathOverflow)?;

    require!(age_seconds <= max_age_seconds, MeridianError::OracleStale);

    // Return a validated close reading
    // Note: We use slot 0 as a placeholder since Pyth uses timestamps, not slots
    Ok(CloseReading {
        value_scaled: reading.value_scaled,
        slot: 0,
    })
}

/// Reads and validates one Pyth price account (domain.md § Settlement rules, M3-10).
///
/// `expected_key` is the Pyth price account pubkey pinned in `Config` for this ticker.
/// `expected_feed_id` is the Pyth feed ID (32-byte identifier) for the ticker.
pub fn read_pyth_close(
    price_account: &AccountInfo,
    expected_key: &Pubkey,
    expected_feed_id: &[u8; 32],
    clock: &Clock,
    close_ts: i64,
    max_staleness_slots: u64,
) -> Result<CloseReading> {
    // Check 1: Owner must be Pyth program or Pyth Push program
    let valid_owner = *price_account.owner == PYTH_MAINNET_PID
        || *price_account.owner == PYTH_DEVNET_PID
        || *price_account.owner == PYTH_PUSH_MAINNET_PID
        || *price_account.owner == PYTH_PUSH_DEVNET_PID;

    require!(valid_owner, MeridianError::OracleWrongOwner);

    // Check 2: Account key must match expected (pinned in Config)
    require_keys_eq!(
        price_account.key(),
        *expected_key,
        MeridianError::OracleFeedHashMismatch
    );

    // Parse the Pyth price account
    let reading = parse_pyth_price(&price_account.try_borrow_data()?)?;

    // Validate the reading
    check_pyth_reading(
        &reading,
        expected_feed_id,
        clock,
        close_ts,
        max_staleness_slots,
    )
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;

    fn clock(slot: u64, unix_timestamp: i64) -> Clock {
        Clock {
            slot,
            unix_timestamp,
            ..Clock::default()
        }
    }

    #[test]
    fn check_pyth_reading_validates_feed_id() {
        let reading = PythReading {
            feed_id: [0xaa; 32],
            value_scaled: 680_000_000_000_000_000_000,
            publish_time: 1_791_316_800,
            confidence: 1_000_000,
        };

        // Correct feed ID passes
        let result = check_pyth_reading(
            &reading,
            &[0xaa; 32],
            &clock(100, 1_791_316_812),
            1_791_316_800,
            30,
        );
        assert!(result.is_ok());

        // Wrong feed ID fails
        let result = check_pyth_reading(
            &reading,
            &[0xbb; 32],
            &clock(100, 1_791_316_812),
            1_791_316_800,
            30,
        );
        assert!(result.is_err());
    }

    #[test]
    fn check_pyth_reading_rejects_before_close() {
        let reading = PythReading {
            feed_id: [0xaa; 32],
            value_scaled: 680_000_000_000_000_000_000,
            publish_time: 1_791_316_799, // 1 second before close
            confidence: 1_000_000,
        };

        let result = check_pyth_reading(
            &reading,
            &[0xaa; 32],
            &clock(100, 1_791_316_812),
            1_791_316_800, // close_ts
            30,
        );
        assert!(result.is_err());
    }

    #[test]
    fn check_pyth_reading_rejects_stale_prices() {
        let close_ts = 1_791_316_800i64;
        let reading = PythReading {
            feed_id: [0xaa; 32],
            value_scaled: 680_000_000_000_000_000_000,
            publish_time: close_ts,
            confidence: 1_000_000,
        };

        // Fresh price (within 12 seconds) passes
        let result = check_pyth_reading(
            &reading,
            &[0xaa; 32],
            &clock(100, close_ts + 12),
            close_ts,
            30, // 30 slots = 12 seconds
        );
        assert!(result.is_ok());

        // Stale price (> 12 seconds) fails
        let result = check_pyth_reading(
            &reading,
            &[0xaa; 32],
            &clock(100, close_ts + 13),
            close_ts,
            30,
        );
        assert!(result.is_err());
    }

    #[test]
    fn check_pyth_reading_rejects_zero_or_negative_price() {
        let reading_zero = PythReading {
            feed_id: [0xaa; 32],
            value_scaled: 0,
            publish_time: 1_791_316_800,
            confidence: 1_000_000,
        };

        let result = check_pyth_reading(
            &reading_zero,
            &[0xaa; 32],
            &clock(100, 1_791_316_812),
            1_791_316_800,
            30,
        );
        assert!(result.is_err());

        let reading_negative = PythReading {
            feed_id: [0xaa; 32],
            value_scaled: -100,
            publish_time: 1_791_316_800,
            confidence: 1_000_000,
        };

        let result = check_pyth_reading(
            &reading_negative,
            &[0xaa; 32],
            &clock(100, 1_791_316_812),
            1_791_316_800,
            30,
        );
        assert!(result.is_err());
    }
}
