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

/// Pyth Solana Receiver program (for Pyth Pro PriceUpdateV2 accounts).
/// This is the program that owns PriceUpdateV2 accounts, from pyth-solana-receiver-sdk.
/// Source: pyth-solana-receiver-sdk declare_id!
pub const PYTH_RECEIVER_PID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// Pyth feed IDs for MAG7 tickers (from issue #49).
/// These are PLACEHOLDER hex strings and MUST be verified against official Pyth documentation.
///
/// TODO: Verify these against docs.pyth.network feed ID list for regular-session US equities.
/// The numeric IDs (922, 954, etc.) from the issue need to be mapped to their hex feed IDs.
/// Note: As of June 2026, extended-hours feeds moved to Pyth Pro; regular-session feeds
/// may have migrated after July 31, 2026 Core upgrade. Verify session type and current IDs.
pub mod feed_ids {
    /// AAPL feed ID: 922 in Pyth Pro (PLACEHOLDER - verify against docs.pyth.network).
    pub const AAPL: &str =
        "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688";
    /// AMZN feed ID: 954 in Pyth Pro (PLACEHOLDER - verify against docs.pyth.network).
    pub const AMZN: &str =
        "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a";
    /// GOOGL feed ID: 1163 in Pyth Pro (PLACEHOLDER - verify against docs.pyth.network).
    pub const GOOGL: &str =
        "0x726c49cd73149a5eb8e5570d0e2cbf01c99853af3e5aeebd01e7eb6e1d15f977";
    /// META feed ID: 1272 in Pyth Pro (PLACEHOLDER - verify against docs.pyth.network).
    pub const META: &str =
        "0x4b78d251770732f6304b1f41e9bebaabc3b256985ef18988f6de8d6562dd254c";
    /// MSFT feed ID: 1292 in Pyth Pro (PLACEHOLDER - verify against docs.pyth.network).
    pub const MSFT: &str =
        "0x4f1b1a0e68b8f1b5e1573eeb95e5b99fda76098146c66c1e5d3e7f0c94bc2294";
    /// NVDA feed ID: 1314 in Pyth Pro (PLACEHOLDER - verify against docs.pyth.network).
    pub const NVDA: &str =
        "0x6fa7e48602d2e6c0f46c1f2ef3d9d4b16d67a7a72f000a83aee12cb4e5d1c7a6";
    /// TSLA feed ID: 1435 in Pyth Pro (PLACEHOLDER - verify against docs.pyth.network).
    pub const TSLA: &str =
        "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc9641f1";
}

/// Pyth PriceUpdateV2 account discriminator (Anchor: sha256("account:PriceUpdateV2")[:8]).
/// Source: pyth-solana-receiver-sdk
pub const PYTH_PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [
    34, 241, 35, 99, 157, 126, 244, 205,
];

/// One Pyth feed's reading, before settlement checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythReading {
    /// Pyth feed ID (32-byte identifier).
    pub feed_id: [u8; 32],
    /// Price value scaled to 18 decimals.
    pub value_scaled: i128,
    /// Unix timestamp of the price update (publish_time).
    pub publish_time: i64,
    /// Confidence interval.
    pub confidence: u64,
    /// Slot when this price was posted on-chain.
    pub posted_slot: u64,
}

fn read_array<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N]> {
    let end = offset.checked_add(N).ok_or(MeridianError::MathOverflow)?;
    data.get(offset..end)
        .and_then(|bytes| <[u8; N]>::try_from(bytes).ok())
        .ok_or_else(|| MeridianError::OracleInvalidValue.into())
}

/// Parses a Pyth PriceUpdateV2 account to extract the reading.
///
/// Fail-closed implementation following oracle::parse_pull_feed pattern.
/// Layout based on pyth-solana-receiver-sdk research (MUST verify against SDK source):
/// - Bytes 0-7: Anchor discriminator
/// - Bytes 8-39: write_authority (32 bytes)
/// - Byte 40+: VerificationLevel enum (variable: Full=1byte, Partial=2bytes)
/// - Following: PriceFeedMessage (feed_id, price, conf, expo, publish_time)
///
/// TODO: Verify exact discriminator, offsets, and field sizes against current SDK.
pub fn parse_pyth_price(data: &[u8]) -> Result<PythReading> {
    // Conservative minimum: 8 (disc) + 32 (auth) + 1 (level) + 68 (message+posted_slot) = 109
    require!(data.len() >= 109, MeridianError::OracleInvalidValue);

    // Check discriminator (fail closed - must match exactly)
    let disc = read_array::<8>(data, 0)?;
    require!(
        disc == PYTH_PRICE_UPDATE_V2_DISCRIMINATOR,
        MeridianError::OracleInvalidValue
    );

    // Parse VerificationLevel to find message offset
    // Borsh encoding: Partial=0 (2 bytes: tag + num_signatures), Full=1 (1 byte: tag only)
    let level_tag = *data.get(40).ok_or(MeridianError::OracleInvalidValue)?;
    let msg_offset = match level_tag {
        0 => 42, // Partial: 2 bytes (tag + num_signatures)
        1 => 41, // Full: 1 byte
        _ => return Err(MeridianError::OracleInvalidValue.into()),
    };

    // PriceFeedMessage layout: feed_id(32) + price(8) + conf(8) + expo(4) + publish_time(8) + posted_slot(8) = 68
    require!(
        data.len() >= msg_offset + 68,
        MeridianError::OracleInvalidValue
    );

    // Parse PriceFeedMessage fields
    let feed_id = read_array::<32>(data, msg_offset)?;
    let price_i64 = i64::from_le_bytes(read_array(data, msg_offset + 32)?);
    let conf = u64::from_le_bytes(read_array(data, msg_offset + 40)?);
    let expo = i32::from_le_bytes(read_array(data, msg_offset + 48)?);
    let publish_time = i64::from_le_bytes(read_array(data, msg_offset + 52)?);
    let posted_slot = u64::from_le_bytes(read_array(data, msg_offset + 60)?);

    // Scale to 18 decimals: price_i64 * 10^expo → value * 10^18
    let price_128 = i128::from(price_i64);
    let scale_power = 18i32.checked_sub(expo).ok_or(MeridianError::MathOverflow)?;
    let value_scaled = if scale_power >= 0 {
        price_128
            .checked_mul(
                10i128
                    .checked_pow(scale_power as u32)
                    .ok_or(MeridianError::MathOverflow)?,
            )
            .ok_or(MeridianError::MathOverflow)?
    } else {
        price_128
            .checked_div(
                10i128
                    .checked_pow((-scale_power) as u32)
                    .ok_or(MeridianError::MathOverflow)?,
            )
            .ok_or(MeridianError::MathOverflow)?
    };

    Ok(PythReading {
        feed_id,
        value_scaled,
        publish_time,
        confidence: conf,
        posted_slot,
    })
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

    // Check 4: Timestamp must not be in future (fail closed)
    let current_time = clock.unix_timestamp;
    require!(
        reading.publish_time <= current_time,
        MeridianError::OracleInvalidValue
    );

    // Check 5: Staleness check in slots like oracle::check_reading
    let age = clock
        .slot
        .checked_sub(reading.posted_slot)
        .ok_or(MeridianError::OracleInvalidValue)?;
    require!(age <= max_staleness_slots, MeridianError::OracleStale);

    Ok(CloseReading {
        value_scaled: reading.value_scaled,
        slot: reading.posted_slot,
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
    // Check 1: Owner must be Pyth Solana Receiver program (PriceUpdateV2 accounts)
    require!(
        *price_account.owner == PYTH_RECEIVER_PID,
        MeridianError::OracleWrongOwner
    );

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
    use proptest::prelude::*;

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

    // Property tests following oracle.rs patterns
    proptest! {
        #[test]
        fn prop_check_reading_is_symmetric_on_feed_id(
            value in 1i128..10i128.pow(26),
            publish_time in 1_700_000_000i64..1_800_000_000i64,
        ) {
            let reading = PythReading {
                feed_id: [0xaa; 32],
                value_scaled: value,
                publish_time,
                confidence: 1_000_000,
            };

            let current_time = publish_time + 10;
            let result_match = check_pyth_reading(
                &reading,
                &[0xaa; 32],
                &clock(100, current_time),
                publish_time,
                30,
            );
            let result_mismatch = check_pyth_reading(
                &reading,
                &[0xbb; 32],
                &clock(100, current_time),
                publish_time,
                30,
            );

            prop_assert!(result_match.is_ok());
            prop_assert!(result_mismatch.is_err());
        }

        #[test]
        fn prop_staleness_check_is_monotonic(
            value in 1i128..10i128.pow(26),
            publish_time in 1_700_000_000i64..1_800_000_000i64,
            age_seconds in 0i64..20,
        ) {
            // If a price passes staleness at age X, it passes at age X-1
            let reading = PythReading {
                feed_id: [0xaa; 32],
                value_scaled: value,
                publish_time,
                confidence: 1_000_000,
            };

            let max_staleness_slots = 30u64; // 12 seconds max age
            let current_time = publish_time + age_seconds;

            let result = check_pyth_reading(
                &reading,
                &[0xaa; 32],
                &clock(100, current_time),
                publish_time,
                max_staleness_slots,
            );

            // If age <= 12 seconds, should pass
            // If age > 12 seconds, should fail
            let should_pass = age_seconds <= 12;
            prop_assert_eq!(result.is_ok(), should_pass);
        }

        #[test]
        fn prop_before_close_always_fails(
            value in 1i128..10i128.pow(26),
            close_ts in 1_700_000_000i64..1_800_000_000i64,
            seconds_before in 1i64..1000,
        ) {
            let publish_time = close_ts - seconds_before;
            let reading = PythReading {
                feed_id: [0xaa; 32],
                value_scaled: value,
                publish_time,
                confidence: 1_000_000,
            };

            let result = check_pyth_reading(
                &reading,
                &[0xaa; 32],
                &clock(100, publish_time + 10),
                close_ts,
                30,
            );

            prop_assert!(result.is_err());
        }

        #[test]
        fn prop_at_or_after_close_can_pass(
            value in 1i128..10i128.pow(26),
            close_ts in 1_700_000_000i64..1_800_000_000i64,
            seconds_after in 0i64..10,
        ) {
            // At or slightly after close, within staleness window
            let publish_time = close_ts + seconds_after;
            let reading = PythReading {
                feed_id: [0xaa; 32],
                value_scaled: value,
                publish_time,
                confidence: 1_000_000,
            };

            let result = check_pyth_reading(
                &reading,
                &[0xaa; 32],
                &clock(100, publish_time + 5), // Within staleness
                close_ts,
                30,
            );

            prop_assert!(result.is_ok());
        }
    }
}
