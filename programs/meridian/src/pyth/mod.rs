//! Pyth oracle adapter (D-055, M3-10): reads and validates Pyth Pro (Lazer) price feeds.
//! This module handles Pyth as the second on-chain price source alongside RedStone, restoring
//! the two-source spread check from D-033.
//!
//! Pyth Pro (formerly Pyth Lazer) delivers signed price updates via REST API (PYTH_API_TOKEN);
//! automation fetches signed updates and submits them with an Ed25519Program signature verification
//! instruction. This program validates the signature against the pinned Pyth Lazer signer pubkey
//! stored in Config (operator-controlled, never hard-trusted from payload), then parses the price.
//!
//! Message format: Pyth Lazer SolanaMessage (pyth-lazer-protocol v0.46.0):
//! - magic (4 bytes LE): 0x8221A329 (SOLANA_FORMAT_MAGIC = 2182742457)
//! - signature (64 bytes): Ed25519 signature
//! - public_key (32 bytes): Ed25519 signer pubkey
//! - payload_len (2 bytes LE): length of payload
//! - payload (variable): PAYLOAD_FORMAT_MAGIC + timestamp_us + channel_id + feeds
//!
//! The transaction MUST include a native Ed25519Program verify instruction with the signed message.
//! The program validates: (a) ed25519 ix program id, (b) signer pubkey equals pinned config value,
//! (c) signed message bytes are EXACTLY the payload being parsed (offsets into that ix's data, not
//! attacker-controlled other ixs), (d) feed id maps to market's ticker, plus timestamp/staleness.
//!
//! Alternative: Pyth Lazer verifier program pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt exists on
//! devnet/mainnet as a future integration option (noted in D-055).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;

use crate::errors::MeridianError;
use crate::oracle::CloseReading;

/// Ed25519 signature verification program ID (native Solana program).
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// Pyth feed IDs for MAG7 tickers (Pyth Pro numeric IDs from issue #49).
/// These numeric IDs from the Pyth Pro API need to be converted to 32-byte feed IDs.
/// The numeric values are: AAPL 922, AMZN 954, GOOGL 1163, META 1272, MSFT 1292, NVDA 1314, TSLA 1435.
///
/// TODO: Verify mapping from numeric Pyth Pro IDs to 32-byte feed IDs used in signed payloads.
/// The payload uses 4-byte LE feed IDs (PriceFeedId(u32) per pyth-lazer-protocol).
pub mod feed_ids {
    /// AAPL Pyth Pro feed ID: 922
    pub const AAPL: u32 = 922;
    /// AMZN Pyth Pro feed ID: 954
    pub const AMZN: u32 = 954;
    /// GOOGL Pyth Pro feed ID: 1163
    pub const GOOGL: u32 = 1163;
    /// META Pyth Pro feed ID: 1272
    pub const META: u32 = 1272;
    /// MSFT Pyth Pro feed ID: 1292
    pub const MSFT: u32 = 1292;
    /// NVDA Pyth Pro feed ID: 1314
    pub const NVDA: u32 = 1314;
    /// TSLA Pyth Pro feed ID: 1435
    pub const TSLA: u32 = 1435;
}

/// Pyth Lazer SolanaMessage format magic (pyth-lazer-protocol v0.46.0).
/// First 4 bytes (LE) of a Solana-targeted price update.
pub const SOLANA_FORMAT_MAGIC: u32 = 2182742457; // 0x8221A329

/// Pyth Lazer PayloadData format magic (pyth-lazer-protocol v0.46.0).
/// First 4 bytes (LE/BE depending on format) of the payload.
pub const PAYLOAD_FORMAT_MAGIC: u32 = 2479346549; // 0x93D3D865

/// One Pyth feed's reading, before settlement checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythReading {
    /// Pyth feed ID (u32 numeric ID).
    pub feed_id: u32,
    /// Price value scaled to 18 decimals.
    pub value_scaled: i128,
    /// Unix timestamp of the price update (microseconds).
    pub timestamp_us: i64,
    /// Confidence interval (if present).
    pub confidence: Option<i64>,
    /// Exponent for price scaling.
    pub exponent: i16,
}

fn read_array<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N]> {
    let end = offset.checked_add(N).ok_or(MeridianError::MathOverflow)?;
    data.get(offset..end)
        .and_then(|bytes| <[u8; N]>::try_from(bytes).ok())
        .ok_or_else(|| MeridianError::OracleInvalidValue.into())
}

/// Vendored minimal parser for Pyth Lazer SolanaMessage format.
/// Based on pyth-lazer-protocol v0.46.0 src/message.rs and src/payload.rs.
///
/// SolanaMessage layout (LE-encoded):
/// - magic (4 bytes): SOLANA_FORMAT_MAGIC = 2182742457
/// - signature (64 bytes): Ed25519 signature
/// - public_key (32 bytes): Ed25519 signer pubkey
/// - payload_len (2 bytes LE): length of payload
/// - payload (variable): PayloadData
///
/// PayloadData layout (LE-encoded):
/// - magic (4 bytes): PAYLOAD_FORMAT_MAGIC = 2479346549
/// - timestamp_us (8 bytes): microseconds since epoch
/// - channel_id (1 byte)
/// - num_feeds (1 byte)
/// - feeds: array of PayloadFeedData
///
/// For simplicity, we parse only the first feed and extract Price and Exponent properties.
pub fn parse_pyth_lazer_message(data: &[u8]) -> Result<(Pubkey, PythReading)> {
    // Minimum length: 4 (magic) + 64 (sig) + 32 (pubkey) + 2 (len) = 102
    require!(data.len() >= 102, MeridianError::OracleInvalidValue);

    // Parse SolanaMessage header
    let magic = u32::from_le_bytes(read_array(data, 0)?);
    require!(
        magic == SOLANA_FORMAT_MAGIC,
        MeridianError::OracleInvalidValue
    );

    // Skip signature (64 bytes) for now - verification happens via Ed25519Program ix
    let public_key_bytes = read_array::<32>(data, 68)?;
    let public_key = Pubkey::new_from_array(public_key_bytes);

    let payload_len = u16::from_le_bytes(read_array(data, 100)?) as usize;
    let payload_start: usize = 102;
    let payload_end = payload_start
        .checked_add(payload_len)
        .ok_or(MeridianError::MathOverflow)?;
    require!(
        data.len() >= payload_end,
        MeridianError::OracleInvalidValue
    );

    let payload = data
        .get(payload_start..payload_end)
        .ok_or(MeridianError::OracleInvalidValue)?;

    // Parse PayloadData header
    require!(
        payload.len() >= 14, // 4 (magic) + 8 (timestamp) + 1 (channel) + 1 (num_feeds)
        MeridianError::OracleInvalidValue
    );

    let payload_magic = u32::from_le_bytes(read_array(payload, 0)?);
    require!(
        payload_magic == PAYLOAD_FORMAT_MAGIC,
        MeridianError::OracleInvalidValue
    );

    let timestamp_us = i64::from_le_bytes(read_array(payload, 4)?);
    // channel_id at offset 12 (1 byte) - skip
    let num_feeds = *payload.get(13).ok_or(MeridianError::OracleInvalidValue)?;

    // We only parse the first feed for now (settlement uses one feed per market)
    require!(num_feeds >= 1, MeridianError::OracleInvalidValue);

    // Feed data starts at offset 14
    let feed_offset = 14;
    require!(
        payload.len() >= feed_offset + 5, // feed_id(4) + num_properties(1)
        MeridianError::OracleInvalidValue
    );

    let feed_id = u32::from_le_bytes(read_array(payload, feed_offset)?);
    let num_properties = *payload
        .get(feed_offset + 4)
        .ok_or(MeridianError::OracleInvalidValue)?;

    // Parse properties to extract Price and Exponent
    let mut property_offset = feed_offset + 5;
    let mut price_value: Option<i64> = None;
    let mut exponent: Option<i16> = None;
    let mut confidence: Option<i64> = None;

    for _ in 0..num_properties {
        require!(
            payload.len() > property_offset,
            MeridianError::OracleInvalidValue
        );
        let property_type = *payload
            .get(property_offset)
            .ok_or(MeridianError::OracleInvalidValue)?;
        property_offset = property_offset
            .checked_add(1)
            .ok_or(MeridianError::MathOverflow)?;

        match property_type {
            0 => {
                // Price property (Option<i64>)
                require!(
                    payload.len() >= property_offset + 9,
                    MeridianError::OracleInvalidValue
                );
                let has_value = *payload
                    .get(property_offset)
                    .ok_or(MeridianError::OracleInvalidValue)?;
                property_offset = property_offset
                    .checked_add(1)
                    .ok_or(MeridianError::MathOverflow)?;

                if has_value != 0 {
                    price_value = Some(i64::from_le_bytes(read_array(payload, property_offset)?));
                }
                property_offset = property_offset
                    .checked_add(8)
                    .ok_or(MeridianError::MathOverflow)?;
            }
            4 => {
                // Exponent property (i16)
                require!(
                    payload.len() >= property_offset + 2,
                    MeridianError::OracleInvalidValue
                );
                exponent = Some(i16::from_le_bytes(read_array(payload, property_offset)?));
                property_offset = property_offset
                    .checked_add(2)
                    .ok_or(MeridianError::MathOverflow)?;
            }
            5 => {
                // Confidence property (Option<i64>)
                require!(
                    payload.len() >= property_offset + 9,
                    MeridianError::OracleInvalidValue
                );
                let has_value = *payload
                    .get(property_offset)
                    .ok_or(MeridianError::OracleInvalidValue)?;
                property_offset = property_offset
                    .checked_add(1)
                    .ok_or(MeridianError::MathOverflow)?;

                if has_value != 0 {
                    confidence = Some(i64::from_le_bytes(read_array(payload, property_offset)?));
                }
                property_offset = property_offset
                    .checked_add(8)
                    .ok_or(MeridianError::MathOverflow)?;
            }
            _ => {
                // Skip unknown property types - this is a fail-open risk
                // For production, enumerate all known types and fail on unknown
                return Err(MeridianError::OracleInvalidValue.into());
            }
        }
    }

    // Both Price and Exponent are required
    let price = price_value.ok_or(MeridianError::OracleInvalidValue)?;
    let expo = exponent.ok_or(MeridianError::OracleInvalidValue)?;

    // Scale to 18 decimals: Pyth price = price * 10^expo, target = price * 10^18
    // So: value_scaled = price * 10^(18 + expo)
    let price_128 = i128::from(price);
    let scale_power = 18i32
        .checked_add(i32::from(expo))
        .ok_or(MeridianError::MathOverflow)?;
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
                    .checked_pow(scale_power.unsigned_abs())
                    .ok_or(MeridianError::MathOverflow)?,
            )
            .ok_or(MeridianError::MathOverflow)?
    };

    Ok((
        public_key,
        PythReading {
            feed_id,
            value_scaled,
            timestamp_us,
            confidence,
            exponent: expo,
        },
    ))
}

/// Validates a Pyth reading: correct feed ID, positive value, timestamp >= close, freshness.
pub fn check_pyth_reading(
    reading: &PythReading,
    expected_feed_id: u32,
    clock: &Clock,
    close_ts: i64,
    max_staleness_seconds: i64,
) -> Result<CloseReading> {
    // Check 1: Feed ID must match expected
    require!(
        reading.feed_id == expected_feed_id,
        MeridianError::OracleFeedHashMismatch
    );

    // Check 2: Value must be strictly positive
    require!(
        reading.value_scaled > 0,
        MeridianError::OracleInvalidValue
    );

    // Check 3: Timestamp must be at or after close_ts (convert to seconds for comparison)
    let timestamp_seconds = reading
        .timestamp_us
        .checked_div(1_000_000)
        .ok_or(MeridianError::MathOverflow)?;
    require!(
        timestamp_seconds >= close_ts,
        MeridianError::OracleBeforeClose
    );

    // Check 4: Timestamp must not be in future
    let current_time = clock.unix_timestamp;
    require!(
        timestamp_seconds <= current_time,
        MeridianError::OracleInvalidValue
    );

    // Check 5: Staleness check (timestamp-based, not slot-based like Core)
    let age = current_time
        .checked_sub(timestamp_seconds)
        .ok_or(MeridianError::OracleInvalidValue)?;
    require!(age <= max_staleness_seconds, MeridianError::OracleStale);

    // Reject zero timestamp (like oracle::check_reading rejects slot == 0)
    require!(
        reading.timestamp_us > 0,
        MeridianError::OracleInvalidValue
    );

    Ok(CloseReading {
        value_scaled: reading.value_scaled,
        slot: clock.slot, // Record current slot for audit trail
    })
}

/// Reads and validates Pyth Lazer signed message from Ed25519Program instruction data.
///
/// The transaction MUST include an Ed25519Program signature verification instruction.
/// This function:
/// 1. Loads the Ed25519 instruction via Instructions sysvar
/// 2. Verifies the program ID is Ed25519Program
/// 3. Extracts and validates the signer pubkey matches `pinned_signer` from Config
/// 4. Parses the signed message data (EXACTLY the payload, not attacker-controlled)
/// 5. Validates the price reading (feed ID, timestamp, staleness)
///
/// Security invariants (AB-03, AB-04, AB-13):
/// - Signer pubkey is pinned in Config, admin-controlled, never trusted from payload
/// - Message bytes are from the ed25519 ix data, not attacker-controlled other ixs
/// - All offsets use checked arithmetic
/// - Feed ID mapping is enforced
/// - Timestamp and staleness rules prevent stale or future prices
#[allow(clippy::too_many_arguments)]
pub fn read_pyth_lazer_close(
    instructions_sysvar: &AccountInfo,
    ed25519_ix_index: u16,
    pinned_signer: &Pubkey,
    expected_feed_id: u32,
    clock: &Clock,
    close_ts: i64,
    max_staleness_seconds: i64,
) -> Result<CloseReading> {
    // Load the Ed25519Program instruction at the specified index
    let ed25519_ix =
        load_instruction_at_checked(ed25519_ix_index as usize, instructions_sysvar)?;

    // Check 1: Program ID must be Ed25519Program
    require_keys_eq!(
        ed25519_ix.program_id,
        ED25519_PROGRAM_ID,
        MeridianError::OracleWrongOwner
    );

    // Ed25519Program instruction data layout (Solana native format):
    // - num_signatures (1 byte): must be 1
    // - padding (1 byte)
    // - signature_offset (2 bytes LE): offset to signature in ix data
    // - signature_instruction_index (2 bytes LE): must match this ix
    // - public_key_offset (2 bytes LE): offset to pubkey in ix data
    // - public_key_instruction_index (2 bytes LE): must match this ix
    // - message_data_offset (2 bytes LE): offset to message data
    // - message_data_size (2 bytes LE): size of message data
    // - message_instruction_index (2 bytes LE): must match this ix
    // Then: signature (64 bytes), pubkey (32 bytes), message (variable)

    let ix_data = &ed25519_ix.data;
    require!(ix_data.len() >= 14, MeridianError::OracleInvalidValue);

    // Parse Ed25519 instruction header
    let num_signatures = *ix_data.get(0).ok_or(MeridianError::OracleInvalidValue)?;
    require!(num_signatures == 1, MeridianError::OracleInvalidValue);

    let _signature_offset = u16::from_le_bytes(read_array(ix_data, 2)?) as usize;
    let signature_ix_index = u16::from_le_bytes(read_array(ix_data, 4)?);
    let public_key_offset = u16::from_le_bytes(read_array(ix_data, 6)?) as usize;
    let public_key_ix_index = u16::from_le_bytes(read_array(ix_data, 8)?);
    let message_data_offset = u16::from_le_bytes(read_array(ix_data, 10)?) as usize;
    let message_data_size = u16::from_le_bytes(read_array(ix_data, 12)?) as usize;
    let message_ix_index = u16::from_le_bytes(read_array(ix_data, 14)?);

    // Check 2: All offsets must point to this same instruction (prevent cross-ix attacks)
    require!(
        signature_ix_index == ed25519_ix_index,
        MeridianError::OracleInvalidValue
    );
    require!(
        public_key_ix_index == ed25519_ix_index,
        MeridianError::OracleInvalidValue
    );
    require!(
        message_ix_index == ed25519_ix_index,
        MeridianError::OracleInvalidValue
    );

    // Check 3: Extract pubkey and verify it matches pinned signer
    let pubkey_end = public_key_offset
        .checked_add(32)
        .ok_or(MeridianError::MathOverflow)?;
    let pubkey_bytes = ix_data
        .get(public_key_offset..pubkey_end)
        .ok_or(MeridianError::OracleInvalidValue)?;
    let signer_pubkey = Pubkey::try_from(pubkey_bytes).map_err(|_| MeridianError::OracleInvalidValue)?;

    require_keys_eq!(
        signer_pubkey,
        *pinned_signer,
        MeridianError::OracleFeedHashMismatch
    );

    // Check 4: Extract message data (EXACTLY the signed payload, not attacker-controlled)
    let message_end = message_data_offset
        .checked_add(message_data_size)
        .ok_or(MeridianError::MathOverflow)?;
    let message_data = ix_data
        .get(message_data_offset..message_end)
        .ok_or(MeridianError::OracleInvalidValue)?;

    // The message data should be the Pyth Lazer PayloadData (without the SolanaMessage envelope)
    // For Pyth Lazer, the Ed25519 signature covers the payload bytes directly
    // Parse the payload as PayloadData
    let (_parsed_signer, reading) = parse_pyth_lazer_payload(message_data)?;

    // Validate the reading
    check_pyth_reading(
        &reading,
        expected_feed_id,
        clock,
        close_ts,
        max_staleness_seconds,
    )
}

/// Parses Pyth Lazer PayloadData from signed message bytes.
/// This is the payload portion that was signed (without SolanaMessage envelope).
fn parse_pyth_lazer_payload(payload: &[u8]) -> Result<(Pubkey, PythReading)> {
    // Minimum: 4 (magic) + 8 (timestamp) + 1 (channel) + 1 (num_feeds) + 5 (feed header)
    require!(
        payload.len() >= 19,
        MeridianError::OracleInvalidValue
    );

    let payload_magic = u32::from_le_bytes(read_array(payload, 0)?);
    require!(
        payload_magic == PAYLOAD_FORMAT_MAGIC,
        MeridianError::OracleInvalidValue
    );

    let timestamp_us = i64::from_le_bytes(read_array(payload, 4)?);
    // channel_id at offset 12 (1 byte) - skip
    let num_feeds = *payload.get(13).ok_or(MeridianError::OracleInvalidValue)?;
    require!(num_feeds >= 1, MeridianError::OracleInvalidValue);

    // Feed data starts at offset 14
    let feed_offset = 14;
    let feed_id = u32::from_le_bytes(read_array(payload, feed_offset)?);
    let num_properties = *payload
        .get(feed_offset + 4)
        .ok_or(MeridianError::OracleInvalidValue)?;

    // Parse properties
    let mut property_offset = feed_offset + 5;
    let mut price_value: Option<i64> = None;
    let mut exponent: Option<i16> = None;
    let mut confidence: Option<i64> = None;

    for _ in 0..num_properties {
        require!(
            payload.len() > property_offset,
            MeridianError::OracleInvalidValue
        );
        let property_type = *payload
            .get(property_offset)
            .ok_or(MeridianError::OracleInvalidValue)?;
        property_offset = property_offset
            .checked_add(1)
            .ok_or(MeridianError::MathOverflow)?;

        match property_type {
            0 => {
                // Price
                require!(
                    payload.len() >= property_offset + 9,
                    MeridianError::OracleInvalidValue
                );
                let has_value = *payload
                    .get(property_offset)
                    .ok_or(MeridianError::OracleInvalidValue)?;
                property_offset = property_offset
                    .checked_add(1)
                    .ok_or(MeridianError::MathOverflow)?;
                if has_value != 0 {
                    price_value = Some(i64::from_le_bytes(read_array(payload, property_offset)?));
                }
                property_offset = property_offset
                    .checked_add(8)
                    .ok_or(MeridianError::MathOverflow)?;
            }
            4 => {
                // Exponent
                exponent = Some(i16::from_le_bytes(read_array(payload, property_offset)?));
                property_offset = property_offset
                    .checked_add(2)
                    .ok_or(MeridianError::MathOverflow)?;
            }
            5 => {
                // Confidence
                require!(
                    payload.len() >= property_offset + 9,
                    MeridianError::OracleInvalidValue
                );
                let has_value = *payload
                    .get(property_offset)
                    .ok_or(MeridianError::OracleInvalidValue)?;
                property_offset = property_offset
                    .checked_add(1)
                    .ok_or(MeridianError::MathOverflow)?;
                if has_value != 0 {
                    confidence = Some(i64::from_le_bytes(read_array(payload, property_offset)?));
                }
                property_offset = property_offset
                    .checked_add(8)
                    .ok_or(MeridianError::MathOverflow)?;
            }
            _ => {
                return Err(MeridianError::OracleInvalidValue.into());
            }
        }
    }

    let price = price_value.ok_or(MeridianError::OracleInvalidValue)?;
    let expo = exponent.ok_or(MeridianError::OracleInvalidValue)?;

    // Scale to 18 decimals
    let price_128 = i128::from(price);
    let scale_power = 18i32
        .checked_add(i32::from(expo))
        .ok_or(MeridianError::MathOverflow)?;
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
                    .checked_pow(scale_power.unsigned_abs())
                    .ok_or(MeridianError::MathOverflow)?,
            )
            .ok_or(MeridianError::MathOverflow)?
    };

    // Return placeholder pubkey (we already verified signer via ed25519 ix)
    Ok((
        Pubkey::default(),
        PythReading {
            feed_id,
            value_scaled,
            timestamp_us,
            confidence,
            exponent: expo,
        },
    ))
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
            feed_id: 922, // AAPL
            value_scaled: 150_000_000_000_000_000_000,
            timestamp_us: 1_791_316_800_000_000,
            confidence: Some(5),
            exponent: -2,
        };

        // Correct feed ID passes
        let result = check_pyth_reading(
            &reading,
            922,
            &clock(100, 1_791_316_812),
            1_791_316_800,
            30,
        );
        assert!(result.is_ok());

        // Wrong feed ID fails
        let result = check_pyth_reading(
            &reading,
            954, // AMZN
            &clock(100, 1_791_316_812),
            1_791_316_800,
            30,
        );
        assert!(result.is_err());
    }

    #[test]
    fn check_pyth_reading_rejects_zero_timestamp() {
        let reading = PythReading {
            feed_id: 922,
            value_scaled: 150_000_000_000_000_000_000,
            timestamp_us: 0, // Zero timestamp
            confidence: Some(5),
            exponent: -2,
        };

        let result = check_pyth_reading(
            &reading,
            922,
            &clock(100, 1_791_316_812),
            0,
            30,
        );
        assert!(result.is_err());
    }

    #[test]
    fn parse_pyth_lazer_message_rejects_wrong_magic() {
        let mut data = vec![0u8; 120];
        // Wrong magic
        data[0..4].copy_from_slice(&0xDEADBEEFu32.to_le_bytes());

        assert!(parse_pyth_lazer_message(&data).is_err());
    }

    #[test]
    fn parse_pyth_lazer_message_rejects_too_short() {
        let data = vec![0u8; 50]; // Too short
        assert!(parse_pyth_lazer_message(&data).is_err());
    }

    // Security tests (AB-03, AB-04, AB-13 coverage at unit level)

    #[test]
    fn check_pyth_reading_rejects_stale_timestamp() {
        let reading = PythReading {
            feed_id: 922,
            value_scaled: 150_000_000_000_000_000_000,
            timestamp_us: 1_791_316_800_000_000, // 1791316800 in seconds
            confidence: Some(5),
            exponent: -2,
        };

        // Stale: timestamp is 100 seconds old, max_staleness is 30
        let result = check_pyth_reading(
            &reading,
            922,
            &clock(100, 1_791_316_900), // 100 seconds later
            1_791_316_800,
            30, // max 30 seconds
        );
        assert!(result.is_err());
    }

    #[test]
    fn check_pyth_reading_rejects_negative_price() {
        let reading = PythReading {
            feed_id: 922,
            value_scaled: -100_000_000_000_000_000_000,
            timestamp_us: 1_791_316_800_000_000,
            confidence: Some(5),
            exponent: -2,
        };

        let result = check_pyth_reading(
            &reading,
            922,
            &clock(100, 1_791_316_812),
            1_791_316_800,
            30,
        );
        assert!(result.is_err());
    }

    #[test]
    fn check_pyth_reading_rejects_future_timestamp() {
        let reading = PythReading {
            feed_id: 922,
            value_scaled: 150_000_000_000_000_000_000,
            timestamp_us: 1_791_316_900_000_000, // Future
            confidence: Some(5),
            exponent: -2,
        };

        // Current time is 1_791_316_800, price is from future
        let result = check_pyth_reading(
            &reading,
            922,
            &clock(100, 1_791_316_800),
            1_791_316_800,
            30,
        );
        assert!(result.is_err());
    }

    #[test]
    fn parse_pyth_lazer_payload_rejects_wrong_payload_magic() {
        let mut payload = vec![0u8; 50];
        // Wrong payload magic
        payload[0..4].copy_from_slice(&0xDEADBEEFu32.to_le_bytes());

        assert!(parse_pyth_lazer_payload(&payload).is_err());
    }

    #[test]
    fn parse_pyth_lazer_payload_rejects_missing_price() {
        // Payload with only Exponent property, missing Price (property 0)
        let mut payload = vec![0u8; 100];
        payload[0..4].copy_from_slice(&PAYLOAD_FORMAT_MAGIC.to_le_bytes());
        payload[4..12].copy_from_slice(&1_791_316_800_000_000i64.to_le_bytes());
        payload[12] = 1; // channel_id
        payload[13] = 1; // num_feeds
        payload[14..18].copy_from_slice(&922u32.to_le_bytes()); // feed_id
        payload[18] = 1; // num_properties
        payload[19] = 4; // property_type = Exponent
        payload[20..22].copy_from_slice(&(-2i16).to_le_bytes());

        // Should fail because Price is required
        assert!(parse_pyth_lazer_payload(&payload[..22]).is_err());
    }

    #[test]
    fn parse_pyth_lazer_payload_rejects_missing_exponent() {
        // Payload with only Price property, missing Exponent (property 4)
        let mut payload = vec![0u8; 100];
        payload[0..4].copy_from_slice(&PAYLOAD_FORMAT_MAGIC.to_le_bytes());
        payload[4..12].copy_from_slice(&1_791_316_800_000_000i64.to_le_bytes());
        payload[12] = 1; // channel_id
        payload[13] = 1; // num_feeds
        payload[14..18].copy_from_slice(&922u32.to_le_bytes()); // feed_id
        payload[18] = 1; // num_properties
        payload[19] = 0; // property_type = Price
        payload[20] = 1; // has_value
        payload[21..29].copy_from_slice(&15000i64.to_le_bytes());

        // Should fail because Exponent is required
        assert!(parse_pyth_lazer_payload(&payload[..29]).is_err());
    }

    #[test]
    fn parse_pyth_lazer_payload_rejects_unknown_property() {
        let mut payload = vec![0u8; 100];
        payload[0..4].copy_from_slice(&PAYLOAD_FORMAT_MAGIC.to_le_bytes());
        payload[4..12].copy_from_slice(&1_791_316_800_000_000i64.to_le_bytes());
        payload[12] = 1; // channel_id
        payload[13] = 1; // num_feeds
        payload[14..18].copy_from_slice(&922u32.to_le_bytes()); // feed_id
        payload[18] = 1; // num_properties
        payload[19] = 99; // property_type = UNKNOWN (not 0, 4, or 5)

        // Should fail on unknown property type (fail-closed)
        assert!(parse_pyth_lazer_payload(&payload[..20]).is_err());
    }
}
