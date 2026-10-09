//! Oracle adapter (D-005, D-028, D-033): the only place that knows how a price feed is laid out.
//! `settle_market` calls [`read_close`] once per feed and [`combine`] once; swapping Switchboard
//! for another oracle later means changing this module only.
//!
//! A Switchboard On-Demand `PullFeedAccountData` is read by hand from its account bytes (no
//! dependency on the `switchboard-on-demand` crate, which pins its own Solana SDK line). The
//! layout below is the crate's `#[repr(C)]` struct at 0.13.x; [`parse_pull_feed`] checks the
//! discriminator and the exact account length, so a layout change fails closed.
//!
//! Owner check: a feed must be owned by the Switchboard On-Demand program. Both the mainnet and
//! the devnet program ids are accepted in every build; the feed account itself is pinned by key
//! in `Config`, so a feed of the "other" network cannot be substituted.
//!
//! Checks for one feed (domain.md § Settlement rules 2 and 3), in order: owner, pinned account,
//! pinned feed hash, usable value, updated at or after `close_ts`, at most `max_staleness_slots`
//! old. A reading is trusted only after all of them pass.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{BPS_DENOMINATOR, RedstonePrice, STRIKE_CENTS_TO_SCALED, SYMBOL_LEN};

/// Switchboard On-Demand program on mainnet-beta.
pub const SWITCHBOARD_MAINNET_PID: Pubkey = pubkey!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
/// Switchboard On-Demand program on devnet.
pub const SWITCHBOARD_DEVNET_PID: Pubkey = pubkey!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");

/// Anchor discriminator of `PullFeedAccountData`.
pub const PULL_FEED_DISCRIMINATOR: [u8; 8] = [196, 27, 108, 196, 10, 215, 219, 40];
/// Total account length: 8-byte discriminator + 3,200-byte struct.
pub const PULL_FEED_LEN: usize = 3_208;
/// Offset of `feed_hash` (after 32 submissions of 64 bytes, `authority`, `queue`, plus the discriminator).
const FEED_HASH_OFFSET: usize = 8 + 2_112;
/// Offset of `last_update_timestamp` (`i64`, unix seconds).
const LAST_UPDATE_TS_OFFSET: usize = 8 + 2_208;
/// Offset of `result.value` (`i128`, 18 fractional digits).
const RESULT_VALUE_OFFSET: usize = 8 + 2_256;
/// Offset of `result.slot` (`u64`, slot of the aggregate).
const RESULT_SLOT_OFFSET: usize = 8 + 2_360;

/// One feed's reading, before the settlement checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeedReading {
    /// Hash of the feed's job definition.
    pub feed_hash: [u8; 32],
    /// Price with 18 fractional digits.
    pub value_scaled: i128,
    /// Slot of the aggregate.
    pub slot: u64,
    /// Unix time of the last update.
    pub updated_at: i64,
}

/// A feed value that passed every check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloseReading {
    /// Price with 18 fractional digits, strictly positive.
    pub value_scaled: i128,
    /// Slot of the aggregate.
    pub slot: u64,
}

fn read_array<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N]> {
    let end = offset.checked_add(N).ok_or(MeridianError::MathOverflow)?;
    data.get(offset..end)
        .and_then(|bytes| <[u8; N]>::try_from(bytes).ok())
        .ok_or_else(|| MeridianError::OracleInvalidValue.into())
}

/// Reads the fields settlement needs from the bytes of a `PullFeedAccountData` account.
pub fn parse_pull_feed(data: &[u8]) -> Result<FeedReading> {
    require!(
        data.len() == PULL_FEED_LEN && data.starts_with(&PULL_FEED_DISCRIMINATOR),
        MeridianError::OracleInvalidValue
    );
    Ok(FeedReading {
        feed_hash: read_array(data, FEED_HASH_OFFSET)?,
        value_scaled: i128::from_le_bytes(read_array(data, RESULT_VALUE_OFFSET)?),
        slot: u64::from_le_bytes(read_array(data, RESULT_SLOT_OFFSET)?),
        updated_at: i64::from_le_bytes(read_array(data, LAST_UPDATE_TS_OFFSET)?),
    })
}

/// Applies checks 3 onward to a parsed reading: pinned hash, positive value, produced at or after
/// close, and fresh.
pub fn check_reading(
    reading: &FeedReading,
    expected_hash: &[u8; 32],
    clock: &Clock,
    close_ts: i64,
    max_staleness_slots: u64,
) -> Result<CloseReading> {
    require!(
        reading.feed_hash == *expected_hash,
        MeridianError::OracleFeedHashMismatch
    );
    require!(
        reading.value_scaled > 0 && reading.slot > 0,
        MeridianError::OracleInvalidValue
    );
    require!(
        reading.updated_at >= close_ts,
        MeridianError::OracleBeforeClose
    );
    let age = clock
        .slot
        .checked_sub(reading.slot)
        .ok_or(MeridianError::OracleInvalidValue)?;
    require!(age <= max_staleness_slots, MeridianError::OracleStale);
    Ok(CloseReading {
        value_scaled: reading.value_scaled,
        slot: reading.slot,
    })
}

/// Reads and validates one feed account (domain.md § Settlement rules 2 and 3).
///
/// `expected_key` and `expected_hash` are the values pinned in `Config` for this ticker and
/// source slot. The `local-oracle` build also accepts a [`LocalFeed`] owned by this program.
pub fn read_close(
    feed: &AccountInfo,
    expected_key: &Pubkey,
    expected_hash: &[u8; 32],
    clock: &Clock,
    close_ts: i64,
    max_staleness_slots: u64,
) -> Result<CloseReading> {
    let reading = if *feed.owner == SWITCHBOARD_MAINNET_PID || *feed.owner == SWITCHBOARD_DEVNET_PID
    {
        require_keys_eq!(
            feed.key(),
            *expected_key,
            MeridianError::OracleFeedHashMismatch
        );
        parse_pull_feed(&feed.try_borrow_data()?)?
    } else {
        local_reading(feed, expected_key)?
    };
    check_reading(
        &reading,
        expected_hash,
        clock,
        close_ts,
        max_staleness_slots,
    )
}

/// Reads and validates a RedStone price (M2-15, D-054 § Settlement rules).
///
/// Checks:
/// - Account is this program's PDA for the ticker
/// - Package timestamp ≥ close_ts and ≤ close_ts + max_package_delay_secs
/// - Posted ≤ max_staleness_slots before current slot
///
/// Returns price as 18-digit oracle value (RedStone stores 8 decimals, scaled to 18).
pub fn read_redstone_price(
    redstone_price: &Account<RedstonePrice>,
    ticker: &[u8; SYMBOL_LEN],
    clock: &Clock,
    close_ts: i64,
    max_package_delay_secs: i64,
    max_staleness_slots: u64,
) -> Result<CloseReading> {
    // Verify PDA for this ticker
    require!(
        redstone_price.symbol == *ticker,
        MeridianError::RedStoneWrongPricePda
    );

    // Package timestamp must be ≥ close_ts
    require!(
        redstone_price.package_timestamp_ms >= close_ts * 1_000,
        MeridianError::OracleBeforeClose
    );

    // Package timestamp must be ≤ close_ts + max_package_delay_secs
    let max_timestamp_ms = close_ts
        .checked_mul(1_000)
        .and_then(|ts| ts.checked_add(max_package_delay_secs * 1_000))
        .ok_or(MeridianError::MathOverflow)?;
    require!(
        redstone_price.package_timestamp_ms <= max_timestamp_ms,
        MeridianError::RedStonePackageTooLate
    );

    // Posted slot must be ≤ max_staleness_slots before current slot
    let age = clock
        .slot
        .checked_sub(redstone_price.posted_slot)
        .ok_or(MeridianError::OracleInvalidValue)?;
    require!(age <= max_staleness_slots, MeridianError::OracleStale);

    // Convert RedStone value (8 decimals) to oracle scale (18 decimals)
    let value_scaled = i128::from(redstone_price.value)
        .checked_mul(10i128.pow(10))
        .ok_or(MeridianError::MathOverflow)?;

    Ok(CloseReading {
        value_scaled,
        slot: redstone_price.posted_slot,
    })
}

#[cfg(feature = "local-oracle")]
fn local_reading(feed: &AccountInfo, expected_key: &Pubkey) -> Result<FeedReading> {
    require_keys_eq!(*feed.owner, crate::ID, MeridianError::OracleWrongOwner);
    require_keys_eq!(
        feed.key(),
        *expected_key,
        MeridianError::OracleFeedHashMismatch
    );
    let local = LocalFeed::try_deserialize(&mut &feed.try_borrow_data()?[..])
        .map_err(|_| MeridianError::OracleInvalidValue)?;
    Ok(FeedReading {
        feed_hash: feed.key().to_bytes(),
        value_scaled: local.value,
        slot: local.slot,
        updated_at: local.updated_at,
    })
}

#[cfg(not(feature = "local-oracle"))]
fn local_reading(_feed: &AccountInfo, _expected_key: &Pubkey) -> Result<FeedReading> {
    Err(MeridianError::OracleWrongOwner.into())
}

/// Combines the two feed values: they must differ by at most `max_conf_bps` of their mean
/// (domain.md § Settlement rules 4). Returns the mean, rounded down.
pub fn combine(first: i128, second: i128, max_conf_bps: u16) -> Result<i128> {
    require!(first > 0 && second > 0, MeridianError::OracleInvalidValue);
    let sum = first
        .checked_add(second)
        .ok_or(MeridianError::MathOverflow)?;
    let mean = sum / 2;
    let spread = first
        .checked_sub(second)
        .ok_or(MeridianError::MathOverflow)?
        .checked_abs()
        .ok_or(MeridianError::MathOverflow)?;
    // spread / mean ≤ max_conf_bps / 10,000, without division.
    let lhs = spread
        .checked_mul(i128::from(BPS_DENOMINATOR))
        .ok_or(MeridianError::MathOverflow)?;
    let rhs = mean
        .checked_mul(i128::from(max_conf_bps))
        .ok_or(MeridianError::MathOverflow)?;
    require!(lhs <= rhs, MeridianError::OracleSpreadTooWide);
    Ok(mean)
}

/// A price in cents as an 18-digit oracle value.
pub fn cents_to_scaled(cents: u64) -> Result<i128> {
    i128::from(cents)
        .checked_mul(STRIKE_CENTS_TO_SCALED)
        .ok_or_else(|| MeridianError::MathOverflow.into())
}

/// True when the close is at or above the strike (YES wins at equality, domain.md § Glossary).
pub fn yes_wins(close_scaled: i128, strike_cents: u64) -> Result<bool> {
    Ok(close_scaled >= cents_to_scaled(strike_cents)?)
}

/// Feed written by `local_oracle_set` (D-028). PDA seeds: `["local_feed", symbol, [source_slot]]`.
/// Exists only in builds with the `local-oracle` feature (AB-22).
#[cfg(feature = "local-oracle")]
#[account]
#[derive(Debug, InitSpace)]
pub struct LocalFeed {
    pub ticker: [u8; crate::state::SYMBOL_LEN],
    pub source_slot: u8,
    /// Price with 18 fractional digits.
    pub value: i128,
    pub slot: u64,
    /// Unix time of the write, from the clock.
    pub updated_at: i64,
    pub bump: u8,
}

/// PDA seed prefix of a [`LocalFeed`].
#[cfg(feature = "local-oracle")]
pub const LOCAL_FEED_SEED: &[u8] = b"local_feed";

#[cfg(test)]
// Test code: the program rules on unwrap/panic/arithmetic do not apply here.
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;
    use base64::prelude::{Engine, BASE64_STANDARD};
    use proptest::prelude::*;

    const FIXTURE: &str =
        include_str!("../../../tests/fixtures/switchboard/pull_feed_meta_tiingo.json");
    const CLOSE_TS: i64 = 1_791_316_800;

    /// The `data` field of the account JSON fixture (`solana account --output json` shape).
    fn fixture() -> (Pubkey, Vec<u8>) {
        let json: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let account = &json["account"];
        let data = account["data"][0].as_str().unwrap();
        let owner = account["owner"].as_str().unwrap().parse().unwrap();
        (owner, BASE64_STANDARD.decode(data).unwrap())
    }

    fn clock(slot: u64) -> Clock {
        Clock {
            slot,
            ..Clock::default()
        }
    }

    #[test]
    fn recorded_fixture_parses() {
        let (owner, data) = fixture();
        assert_eq!(owner, SWITCHBOARD_DEVNET_PID);
        let reading = parse_pull_feed(&data).unwrap();
        assert_eq!(reading.value_scaled, 681_250_000_000_000_000_000);
        assert_eq!(reading.slot, 412_345_678);
        assert_eq!(reading.updated_at, CLOSE_TS + 301);
        assert_eq!(reading.feed_hash, [0xab; 32]);
    }

    #[test]
    fn recorded_fixture_passes_all_checks_and_fails_each_one() {
        let (_, data) = fixture();
        let reading = parse_pull_feed(&data).unwrap();
        let ok = check_reading(
            &reading,
            &[0xab; 32],
            &clock(reading.slot + 30),
            CLOSE_TS,
            30,
        );
        assert_eq!(ok.unwrap().value_scaled, reading.value_scaled);
        let stale = check_reading(
            &reading,
            &[0xab; 32],
            &clock(reading.slot + 31),
            CLOSE_TS,
            30,
        );
        assert!(stale.is_err());
        let wrong_hash = check_reading(&reading, &[0xcd; 32], &clock(reading.slot), CLOSE_TS, 30);
        assert!(wrong_hash.is_err());
        let early = check_reading(
            &reading,
            &[0xab; 32],
            &clock(reading.slot),
            reading.updated_at + 1,
            30,
        );
        assert!(early.is_err());
        let future = check_reading(
            &reading,
            &[0xab; 32],
            &clock(reading.slot - 1),
            CLOSE_TS,
            30,
        );
        assert!(future.is_err());
    }

    #[test]
    fn malformed_accounts_are_rejected() {
        let (_, data) = fixture();
        assert!(parse_pull_feed(&data[..PULL_FEED_LEN - 1]).is_err());
        let mut extended = data.clone();
        extended.push(0);
        assert!(parse_pull_feed(&extended).is_err());
        let mut wrong_discriminator = data;
        wrong_discriminator[0] ^= 1;
        assert!(parse_pull_feed(&wrong_discriminator).is_err());
        assert!(parse_pull_feed(&[]).is_err());
    }

    #[test]
    fn combine_enforces_the_spread() {
        let price = 680 * 10i128.pow(18);
        // 5 bps of the ~680 mean is ~0.34: a spread of 0.34 passes, 0.341 fails.
        let spread = 340_000_000_000_000_000i128;
        assert_eq!(
            combine(price, price + spread, 5).unwrap(),
            price + spread / 2
        );
        assert!(combine(price, price + 341_000_000_000_000_000, 5).is_err());
        assert!(combine(0, price, 5).is_err());
        assert!(combine(price, -price, 5).is_err());
    }

    #[test]
    fn yes_wins_at_equality() {
        let strike = 68_000u64;
        let at = cents_to_scaled(strike).unwrap();
        assert!(yes_wins(at, strike).unwrap());
        assert!(yes_wins(at + 1, strike).unwrap());
        assert!(!yes_wins(at - 1, strike).unwrap());
    }

    proptest! {
        #[test]
        fn outcome_matches_integer_comparison(close in 1i128..10i128.pow(26), strike_tens in 1u64..2_000) {
            let strike = strike_tens * 1_000;
            prop_assert_eq!(
                yes_wins(close, strike).unwrap(),
                close >= i128::from(strike) * 10i128.pow(16)
            );
        }

        #[test]
        fn mean_is_between_the_inputs_and_symmetric(
            a in 1i128..10i128.pow(26),
            b in 1i128..10i128.pow(26),
            bps in 1u16..=10_000,
        ) {
            let forward = combine(a, b, bps);
            prop_assert_eq!(forward.is_ok(), combine(b, a, bps).is_ok());
            if let Ok(mean) = forward {
                prop_assert!(mean >= a.min(b) && mean <= a.max(b));
                prop_assert_eq!(mean, combine(b, a, bps).unwrap());
            }
        }

        #[test]
        fn mean_never_flips_a_decision_the_strike_would_make(
            a in 1i128..10i128.pow(26),
            b in 1i128..10i128.pow(26),
            strike_tens in 1u64..2_000,
        ) {
            // If both feeds are at or above the strike, so is the mean (and the same below).
            let strike = strike_tens * 1_000;
            if let Ok(mean) = combine(a, b, 10_000) {
                if yes_wins(a, strike).unwrap() && yes_wins(b, strike).unwrap() {
                    prop_assert!(yes_wins(mean, strike).unwrap());
                }
                if !yes_wins(a, strike).unwrap() && !yes_wins(b, strike).unwrap() {
                    prop_assert!(!yes_wins(mean, strike).unwrap());
                }
            }
        }
    }
}
