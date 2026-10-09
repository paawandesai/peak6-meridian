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

    // Parse VerificationLevel: ONLY accept Full verification for settlement (AB-04)
    // Partial verification (tag 0, including 0 signatures) is unsafe per Pyth SDK docs
    let level_tag = *data.get(40).ok_or(MeridianError::OracleInvalidValue)?;
    require!(level_tag == 1, MeridianError::OracleInvalidValue); // Fail if not Full

    let msg_offset = 41; // Full: 1 byte
    let expected_len = 133; // 8 + 32 + 1 + 84 + 8

    // Exact length check (fail closed)
    require!(data.len() == expected_len, MeridianError::OracleInvalidValue);

    // Parse PriceFeedMessage (SDK layout, 84 bytes total):
    // feed_id(32) + price(8) + conf(8) + exponent(4) + publish_time(8) +
    // prev_publish_time(8) + ema_price(8) + ema_conf(8)
    // Use checked_add for all offsets (clippy::arithmetic_side_effects denied)
    let feed_id = read_array::<32>(data, msg_offset)?;
    let price_i64 = i64::from_le_bytes(read_array(
        data,
        msg_offset.checked_add(32).ok_or(MeridianError::MathOverflow)?,
    )?);
    let conf = u64::from_le_bytes(read_array(
        data,
        msg_offset.checked_add(40).ok_or(MeridianError::MathOverflow)?,
    )?);
    let expo = i32::from_le_bytes(read_array(
        data,
        msg_offset.checked_add(48).ok_or(MeridianError::MathOverflow)?,
    )?);
    let publish_time = i64::from_le_bytes(read_array(
        data,
        msg_offset.checked_add(52).ok_or(MeridianError::MathOverflow)?,
    )?);
    // Skip: prev_publish_time(8) at +60, ema_price(8) at +68, ema_conf(8) at +76
    // posted_slot is after PriceFeedMessage: msg_offset + 84
    let posted_slot = u64::from_le_bytes(read_array(
        data,
        msg_offset.checked_add(84).ok_or(MeridianError::MathOverflow)?,
    )?);

    // Scale to 18 decimals: Pyth price = price_i64 * 10^expo, target = price * 10^18
    // So: value_scaled = price_i64 * 10^(18 + expo)
    let price_128 = i128::from(price_i64);
    let scale_power = 18i32.checked_add(expo).ok_or(MeridianError::MathOverflow)?;
    let value_scaled = if scale_power >= 0 {
        price_128
            .checked_mul(
                10i128
                    .checked_pow(scale_power as u32)
                    .ok_or(MeridianError::MathOverflow)?,
            )
            .ok_or(MeridianError::MathOverflow)?
    } else {
        // scale_power < 0: use unsigned_abs to avoid arithmetic_side_effects lint
        price_128
            .checked_div(
                10i128
                    .checked_pow(scale_power.unsigned_abs())
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
            posted_slot: 90,
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
            posted_slot: 90,
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
            posted_slot: 90,
        };

        // Fresh price (within 30 slots) passes
        let result = check_pyth_reading(
            &reading,
            &[0xaa; 32],
            &clock(119, close_ts + 12), // 119 - 90 = 29 slots
            close_ts,
            30,
        );
        assert!(result.is_ok());

        // Stale price (> 30 slots) fails
        let result = check_pyth_reading(
            &reading,
            &[0xaa; 32],
            &clock(121, close_ts + 13), // 121 - 90 = 31 slots
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
            posted_slot: 90,
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
            posted_slot: 90,
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
                posted_slot: 90,
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
            age_slots in 0u64..50,
        ) {
            // If a price passes staleness at age X, it passes at age X-1
            let posted_slot = 100u64;
            let reading = PythReading {
                feed_id: [0xaa; 32],
                value_scaled: value,
                publish_time,
                confidence: 1_000_000,
                posted_slot,
            };

            let max_staleness_slots = 30u64;
            let current_slot = posted_slot + age_slots;

            let result = check_pyth_reading(
                &reading,
                &[0xaa; 32],
                &clock(current_slot, publish_time + 10),
                publish_time,
                max_staleness_slots,
            );

            // If age <= 30 slots, should pass; otherwise fail
            let should_pass = age_slots <= 30;
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
                posted_slot: 90,
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
                posted_slot: 90,
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

    // Fixture tests following oracle.rs pattern
    const FIXTURE: &str =
        include_str!("../../tests/fixtures/pyth/price_update_v2_aapl.json");
    const AAPL_FEED_ID: [u8; 32] = [
        0x49, 0xf6, 0xb6, 0x5c, 0xb1, 0xde, 0x6b, 0x10, 0xea, 0xf7, 0x5e, 0x7c, 0x03, 0xca,
        0x02, 0x9c, 0x30, 0x6d, 0x03, 0x57, 0xe9, 0x1b, 0x53, 0x11, 0xb1, 0x75, 0x08, 0x4a,
        0x5a, 0xd5, 0x56, 0x88,
    ];

    /// Parse the fixture account JSON
    fn fixture() -> (Pubkey, Vec<u8>) {
        use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
        let json: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let account = &json["account"];
        let data = account["data"][0].as_str().unwrap();
        let owner = account["owner"].as_str().unwrap().parse().unwrap();
        (owner, BASE64_STANDARD.decode(data).unwrap())
    }

    #[test]
    fn recorded_fixture_parses() {
        let (owner, data) = fixture();
        assert_eq!(owner, PYTH_RECEIVER_PID);
        let reading = parse_pyth_price(&data).unwrap();
        // Expected: 15000 * 10^(18+(-2)) = 15000 * 10^16 = $150 * 10^18
        assert_eq!(reading.value_scaled, 150_000_000_000_000_000_000);
        assert_eq!(reading.publish_time, 1791316801);
        assert_eq!(reading.confidence, 5);
        assert_eq!(reading.posted_slot, 412345678);
        assert_eq!(reading.feed_id, AAPL_FEED_ID);
    }

    #[test]
    fn recorded_fixture_passes_all_checks_and_fails_each_one() {
        let (_, data) = fixture();
        let reading = parse_pyth_price(&data).unwrap();
        let close_ts = 1791316800i64; // 1 second before fixture publish_time

        // Should pass: correct feed_id, after close, within staleness
        let ok = check_pyth_reading(
            &reading,
            &AAPL_FEED_ID,
            &clock(reading.posted_slot + 20, reading.publish_time + 5),
            close_ts,
            30,
        );
        assert_eq!(ok.unwrap().value_scaled, reading.value_scaled);

        // Fail: stale (> 30 slots old)
        let stale = check_pyth_reading(
            &reading,
            &AAPL_FEED_ID,
            &clock(reading.posted_slot + 31, reading.publish_time + 15),
            close_ts,
            30,
        );
        assert!(stale.is_err());

        // Fail: wrong feed_id
        let wrong_hash = check_pyth_reading(
            &reading,
            &[0xcd; 32],
            &clock(reading.posted_slot + 20, reading.publish_time + 5),
            close_ts,
            30,
        );
        assert!(wrong_hash.is_err());

        // Fail: published before close_ts
        let early = check_pyth_reading(
            &reading,
            &AAPL_FEED_ID,
            &clock(reading.posted_slot + 20, reading.publish_time + 5),
            reading.publish_time + 1,
            30,
        );
        assert!(early.is_err());

        // Fail: future posted_slot
        let future = check_pyth_reading(
            &reading,
            &AAPL_FEED_ID,
            &clock(reading.posted_slot - 1, reading.publish_time + 5),
            close_ts,
            30,
        );
        assert!(future.is_err());
    }

    #[test]
    fn malformed_pyth_accounts_are_rejected() {
        let (_, data) = fixture();

        // Too short
        assert!(parse_pyth_price(&data[..data.len() - 1]).is_err());

        // Wrong discriminator
        let mut wrong_disc = data;
        wrong_disc[0] ^= 1;
        assert!(parse_pyth_price(&wrong_disc).is_err());

        // Empty
        assert!(parse_pyth_price(&[]).is_err());
    }

    #[test]
    fn partial_verification_is_rejected() {
        // Partial verification (tag 0) is unsafe for settlement (AB-04)
        let (_, mut data) = fixture();

        // Change VerificationLevel from Full (1) to Partial (0) at offset 40
        data[40] = 0;

        // Should reject Partial verification
        assert!(parse_pyth_price(&data).is_err());
    }
}
