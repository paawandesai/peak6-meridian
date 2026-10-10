//! Pyth oracle adapter (D-055, M3-10): reads and validates Pyth Pro (Lazer) price feeds.
//! This module handles Pyth as the second on-chain price source alongside RedStone, restoring
//! the two-source spread check from D-033.
//!
//! Pyth Pro (formerly Pyth Lazer) delivers signed price updates via REST API (PYTH_API_TOKEN);
//! automation fetches the signed update at the market's close and submits it with an
//! Ed25519Program signature verification instruction. This program validates the signature
//! against the pinned Pyth Lazer signer pubkey stored in Config (operator-controlled, never
//! hard-trusted from payload), then parses the price.
//!
//! Wire format (pyth-lazer-protocol v0.46.0, `message.rs` and `payload.rs`, little-endian):
//! - SolanaMessage: magic u32 (`SOLANA_FORMAT_MAGIC`), signature [u8; 64], public key [u8; 32],
//!   payload length u16, payload. The Ed25519 signature covers the payload bytes only.
//! - PayloadData: magic u32 (`PAYLOAD_FORMAT_MAGIC`), timestamp_us u64, channel u8, feed count
//!   u8, then per feed: feed id u32, property count u8, and per property its id u8 followed by
//!   its value. Price (0) and Confidence (5) are a bare i64 mantissa where 0 means "absent";
//!   Exponent (4) is an i16.
//!
//! The transaction MUST include a native Ed25519Program verify instruction with the signed message.
//! The program validates: (a) ed25519 ix program id, (b) signer pubkey equals pinned config value,
//! (c) signed message bytes are EXACTLY the payload being parsed (offsets into that ix's data, not
//! attacker-controlled other ixs), (d) feed id maps to market's ticker, (e) the update was taken
//! in the window `[close_ts, close_ts + pyth_max_age_secs]`, (f) confidence ≤ `max_conf_bps`.
//!
//! Alternative: Pyth Lazer verifier program pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt exists on
//! devnet/mainnet as a future integration option (noted in D-055).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::errors::MeridianError;
use crate::oracle::CloseReading;
use crate::state::BPS_DENOMINATOR;

/// Ed25519 signature verification program ID (native Solana program).
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// Pyth Pro numeric feed ids of the MAG7 regular-session equity feeds (issue #49). The signed
/// payload carries them as a u32 (`PriceFeedId(u32)` in pyth-lazer-protocol).
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

/// Pyth Lazer PayloadData format magic (pyth-lazer-protocol v0.46.0), first 4 bytes (LE).
pub const PAYLOAD_FORMAT_MAGIC: u32 = 2479346549; // 0x93D3D865

/// `PriceFeedProperty` ids (pyth-lazer-protocol v0.46.0 `lib.rs`, `#[repr(u8)]` order). Only the
/// three settlement needs are accepted; any other property fails the parse (fail closed).
pub mod property {
    pub const PRICE: u8 = 0;
    pub const EXPONENT: u8 = 4;
    pub const CONFIDENCE: u8 = 5;
}

/// SolanaMessage envelope: magic (4) + signature (64) + public key (32) + payload length (2).
const ENVELOPE_LEN: usize = 102;

/// One Pyth feed's reading, before settlement checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythReading {
    /// Pyth feed ID (u32 numeric ID).
    pub feed_id: u32,
    /// Price value scaled to 18 decimals.
    pub value_scaled: i128,
    /// Unix timestamp of the price update (microseconds).
    pub timestamp_us: i64,
    /// Price mantissa as signed (same exponent as `confidence`).
    pub price: i64,
    /// Confidence mantissa, if present.
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

/// A forward-only reader over the payload; every read is bounds-checked.
struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N]> {
        let bytes = read_array::<N>(self.data, self.pos)?;
        self.pos = self.pos.checked_add(N).ok_or(MeridianError::MathOverflow)?;
        Ok(bytes)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(u8::from_le_bytes(self.take()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take()?))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take()?))
    }
    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(self.take()?))
    }
    fn i16(&mut self) -> Result<i16> {
        Ok(i16::from_le_bytes(self.take()?))
    }
}

/// Parses a full SolanaMessage (envelope + payload) and returns the envelope's public key with
/// the payload's reading. Does NOT verify the signature; on-chain that is the Ed25519Program's
/// job (see [`read_pyth_lazer_close`]).
pub fn parse_pyth_lazer_message(data: &[u8]) -> Result<(Pubkey, PythReading)> {
    let mut reader = Reader { data, pos: 0 };
    require!(
        reader.u32()? == SOLANA_FORMAT_MAGIC,
        MeridianError::OracleInvalidValue
    );
    let _signature = reader.take::<64>()?;
    let public_key = Pubkey::new_from_array(reader.take::<32>()?);
    let payload_len = usize::from(u16::from_le_bytes(reader.take()?));
    let payload_end = ENVELOPE_LEN
        .checked_add(payload_len)
        .ok_or(MeridianError::MathOverflow)?;
    require!(data.len() == payload_end, MeridianError::OracleInvalidValue);
    let payload = data
        .get(ENVELOPE_LEN..payload_end)
        .ok_or(MeridianError::OracleInvalidValue)?;
    Ok((public_key, parse_pyth_lazer_payload(payload)?))
}

/// Parses a signed `PayloadData`. Settlement requests exactly one feed with Price, Exponent and
/// Confidence, so anything else (more feeds, other or repeated properties, trailing bytes) is
/// rejected rather than skipped.
pub fn parse_pyth_lazer_payload(payload: &[u8]) -> Result<PythReading> {
    let mut reader = Reader {
        data: payload,
        pos: 0,
    };
    require!(
        reader.u32()? == PAYLOAD_FORMAT_MAGIC,
        MeridianError::OracleInvalidValue
    );
    let timestamp_us =
        i64::try_from(reader.u64()?).map_err(|_| MeridianError::OracleInvalidValue)?;
    let _channel = reader.u8()?;
    require!(reader.u8()? == 1, MeridianError::OracleInvalidValue);
    let feed_id = reader.u32()?;
    let num_properties = reader.u8()?;

    let mut price: Option<i64> = None;
    let mut exponent: Option<i16> = None;
    let mut confidence: Option<Option<i64>> = None;
    for _ in 0..num_properties {
        match reader.u8()? {
            property::PRICE if price.is_none() => price = Some(reader.i64()?),
            property::EXPONENT if exponent.is_none() => exponent = Some(reader.i16()?),
            property::CONFIDENCE if confidence.is_none() => {
                // 0 is the wire encoding of "no confidence".
                let value = reader.i64()?;
                confidence = Some((value != 0).then_some(value));
            }
            _ => return Err(MeridianError::OracleInvalidValue.into()),
        }
    }
    require!(
        reader.pos == payload.len(),
        MeridianError::OracleInvalidValue
    );

    // Price 0 is the wire encoding of "no price"; a missing exponent is malformed.
    let price = price
        .filter(|value| *value != 0)
        .ok_or(MeridianError::OracleInvalidValue)?;
    let exponent = exponent.ok_or(MeridianError::OracleInvalidValue)?;
    Ok(PythReading {
        feed_id,
        value_scaled: scale_to_18(price, exponent)?,
        timestamp_us,
        price,
        confidence: confidence.flatten(),
        exponent,
    })
}

/// `price × 10^exponent` expressed with 18 fractional digits.
fn scale_to_18(price: i64, exponent: i16) -> Result<i128> {
    let price = i128::from(price);
    let power = 18i32
        .checked_add(i32::from(exponent))
        .ok_or(MeridianError::MathOverflow)?;
    let factor = 10i128
        .checked_pow(power.unsigned_abs())
        .ok_or(MeridianError::MathOverflow)?;
    let scaled = if power >= 0 {
        price.checked_mul(factor)
    } else {
        price.checked_div(factor)
    };
    scaled.ok_or_else(|| MeridianError::MathOverflow.into())
}

/// Validates a Pyth reading for a market closing at `close_ts`: the pinned feed, a positive
/// price, an update taken in `[close_ts, close_ts + close_window_secs]` and not in the future,
/// and a confidence no wider than `max_conf_bps` of the price.
///
/// The window is anchored on the close, not on the current time: `settle_market` is
/// permissionless, so a bound relative to "now" would let anyone wait for the after-hours price
/// to move and settle with a later, equally well-signed update.
pub fn check_pyth_reading(
    reading: &PythReading,
    expected_feed_id: u32,
    clock: &Clock,
    close_ts: i64,
    close_window_secs: i64,
    max_conf_bps: u16,
) -> Result<CloseReading> {
    require!(
        reading.feed_id == expected_feed_id,
        MeridianError::OracleFeedHashMismatch
    );
    require!(
        reading.price > 0 && reading.value_scaled > 0,
        MeridianError::OracleInvalidValue
    );
    require!(reading.timestamp_us > 0, MeridianError::OracleInvalidValue);

    let timestamp = reading
        .timestamp_us
        .checked_div(1_000_000)
        .ok_or(MeridianError::MathOverflow)?;
    require!(timestamp >= close_ts, MeridianError::OracleBeforeClose);
    let window_end = close_ts
        .checked_add(close_window_secs)
        .ok_or(MeridianError::MathOverflow)?;
    require!(timestamp <= window_end, MeridianError::PythAfterCloseWindow);
    require!(
        timestamp <= clock.unix_timestamp,
        MeridianError::OracleInvalidValue
    );

    // confidence / price ≤ max_conf_bps / 10_000, cross-multiplied (same exponent on both).
    let confidence = reading
        .confidence
        .filter(|value| *value > 0)
        .ok_or(MeridianError::PythConfidenceTooWide)?;
    let lhs = i128::from(confidence)
        .checked_mul(i128::from(BPS_DENOMINATOR))
        .ok_or(MeridianError::MathOverflow)?;
    let rhs = i128::from(reading.price)
        .checked_mul(i128::from(max_conf_bps))
        .ok_or(MeridianError::MathOverflow)?;
    require!(lhs <= rhs, MeridianError::PythConfidenceTooWide);

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
/// 5. Validates the price reading ([`check_pyth_reading`])
///
/// Security invariants (AB-03, AB-04, AB-13):
/// - Signer pubkey is pinned in Config, admin-controlled, never trusted from payload
/// - Message bytes are from the ed25519 ix data, not attacker-controlled other ixs
/// - All offsets use checked arithmetic
/// - Feed ID mapping is enforced
/// - The update must come from the close window and carry a tight confidence
#[allow(clippy::too_many_arguments)]
pub fn read_pyth_lazer_close(
    instructions_sysvar: &AccountInfo,
    ed25519_ix_index: u16,
    pinned_signer: &Pubkey,
    expected_feed_id: u32,
    clock: &Clock,
    close_ts: i64,
    close_window_secs: i64,
    max_conf_bps: u16,
) -> Result<CloseReading> {
    // Load the Ed25519Program instruction at the specified index
    let ed25519_ix = load_instruction_at_checked(ed25519_ix_index as usize, instructions_sysvar)?;

    // Check 1: Ed25519 instruction must have already executed (prevent sysvar bypass)
    // Require ed25519_ix_index < current_index to ensure the signature was verified
    // before this instruction runs. An attacker cannot supply a later unverified ix.
    let current_index = load_current_index_checked(instructions_sysvar)?;
    require!(
        ed25519_ix_index < current_index,
        MeridianError::OracleInvalidValue
    );

    // Check 2: Program ID must be Ed25519Program
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
    require!(ix_data.len() >= 16, MeridianError::OracleInvalidValue);

    // Parse Ed25519 instruction header
    let num_signatures = *ix_data.first().ok_or(MeridianError::OracleInvalidValue)?;
    require!(num_signatures == 1, MeridianError::OracleInvalidValue);

    let signature_ix_index = u16::from_le_bytes(read_array(ix_data, 4)?);
    let public_key_offset = u16::from_le_bytes(read_array(ix_data, 6)?) as usize;
    let public_key_ix_index = u16::from_le_bytes(read_array(ix_data, 8)?);
    let message_data_offset = u16::from_le_bytes(read_array(ix_data, 10)?) as usize;
    let message_data_size = u16::from_le_bytes(read_array(ix_data, 12)?) as usize;
    let message_ix_index = u16::from_le_bytes(read_array(ix_data, 14)?);

    // Check 3: All offsets must point to this same instruction (prevent cross-ix attacks)
    // Accept u16::MAX as sentinel for "this instruction" (web3.js/new_ed25519_instruction)
    let is_valid_ix_index = |ix: u16| ix == ed25519_ix_index || ix == u16::MAX;
    require!(
        is_valid_ix_index(signature_ix_index),
        MeridianError::OracleInvalidValue
    );
    require!(
        is_valid_ix_index(public_key_ix_index),
        MeridianError::OracleInvalidValue
    );
    require!(
        is_valid_ix_index(message_ix_index),
        MeridianError::OracleInvalidValue
    );

    // Check 4: Extract pubkey and verify it matches pinned signer
    let pubkey_end = public_key_offset
        .checked_add(32)
        .ok_or(MeridianError::MathOverflow)?;
    let pubkey_bytes = ix_data
        .get(public_key_offset..pubkey_end)
        .ok_or(MeridianError::OracleInvalidValue)?;
    let signer_pubkey =
        Pubkey::try_from(pubkey_bytes).map_err(|_| MeridianError::OracleInvalidValue)?;

    require_keys_eq!(
        signer_pubkey,
        *pinned_signer,
        MeridianError::PythWrongSigner
    );

    // Check 5: Extract message data (EXACTLY the signed payload, not attacker-controlled).
    // Pyth signs the PayloadData bytes alone (no SolanaMessage envelope).
    let message_end = message_data_offset
        .checked_add(message_data_size)
        .ok_or(MeridianError::MathOverflow)?;
    let message_data = ix_data
        .get(message_data_offset..message_end)
        .ok_or(MeridianError::OracleInvalidValue)?;
    let reading = parse_pyth_lazer_payload(message_data)?;

    check_pyth_reading(
        &reading,
        expected_feed_id,
        clock,
        close_ts,
        close_window_secs,
        max_conf_bps,
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

    const CLOSE: i64 = 1_791_316_800;

    fn clock(slot: u64, unix_timestamp: i64) -> Clock {
        Clock {
            slot,
            unix_timestamp,
            ..Clock::default()
        }
    }

    /// A payload in the real wire encoding with the given properties, in order.
    fn payload(feed_id: u32, timestamp_us: u64, properties: &[(u8, Vec<u8>)]) -> Vec<u8> {
        let mut out = PAYLOAD_FORMAT_MAGIC.to_le_bytes().to_vec();
        out.extend_from_slice(&timestamp_us.to_le_bytes());
        out.push(2); // channel fixed_rate@200ms
        out.push(1);
        out.extend_from_slice(&feed_id.to_le_bytes());
        out.push(properties.len() as u8);
        for (id, value) in properties {
            out.push(*id);
            out.extend_from_slice(value);
        }
        out
    }

    fn standard(price: i64, confidence: i64) -> Vec<(u8, Vec<u8>)> {
        vec![
            (property::PRICE, price.to_le_bytes().to_vec()),
            (property::EXPONENT, (-8i16).to_le_bytes().to_vec()),
            (property::CONFIDENCE, confidence.to_le_bytes().to_vec()),
        ]
    }

    fn reading(timestamp_us: i64, price: i64, confidence: Option<i64>) -> PythReading {
        PythReading {
            feed_id: 922,
            value_scaled: i128::from(price) * 10i128.pow(10),
            timestamp_us,
            price,
            confidence,
            exponent: -8,
        }
    }

    #[test]
    fn parses_the_real_wire_encoding() {
        let bytes = payload(
            922,
            (CLOSE as u64) * 1_000_000,
            &standard(25_412_000_000, 1_500_000),
        );
        let parsed = parse_pyth_lazer_payload(&bytes).unwrap();
        assert_eq!(parsed.feed_id, 922);
        assert_eq!(parsed.price, 25_412_000_000);
        assert_eq!(parsed.confidence, Some(1_500_000));
        assert_eq!(parsed.exponent, -8);
        assert_eq!(parsed.value_scaled, 25_412_000_000 * 10i128.pow(10));
        assert_eq!(parsed.timestamp_us, CLOSE * 1_000_000);
    }

    #[test]
    fn parses_the_envelope_and_returns_its_signer() {
        let body = payload(922, 1, &standard(1, 0));
        let mut message = SOLANA_FORMAT_MAGIC.to_le_bytes().to_vec();
        message.extend_from_slice(&[7u8; 64]);
        message.extend_from_slice(&[9u8; 32]);
        message.extend_from_slice(&(body.len() as u16).to_le_bytes());
        message.extend_from_slice(&body);
        let (signer, parsed) = parse_pyth_lazer_message(&message).unwrap();
        assert_eq!(signer, Pubkey::new_from_array([9u8; 32]));
        assert_eq!(parsed.confidence, None);
        message.push(0);
        assert!(parse_pyth_lazer_message(&message).is_err(), "trailing byte");
    }

    #[test]
    fn rejects_wrong_magics_and_short_input() {
        assert!(parse_pyth_lazer_message(&[0u8; 50]).is_err());
        let mut message = vec![0u8; 120];
        message[0..4].copy_from_slice(&0xDEADBEEFu32.to_le_bytes());
        assert!(parse_pyth_lazer_message(&message).is_err());
        let mut body = payload(922, 1, &standard(1, 1));
        body[0] ^= 0xff;
        assert!(parse_pyth_lazer_payload(&body).is_err());
    }

    #[test]
    fn rejects_a_missing_or_zero_price_and_a_missing_exponent() {
        let no_price = payload(922, 1, &standard(1, 1)[1..]);
        assert!(parse_pyth_lazer_payload(&no_price).is_err());
        let zero_price = payload(922, 1, &standard(0, 1));
        assert!(parse_pyth_lazer_payload(&zero_price).is_err());
        let props = standard(1, 1);
        let no_exponent = payload(922, 1, &[props[0].clone(), props[2].clone()]);
        assert!(parse_pyth_lazer_payload(&no_exponent).is_err());
    }

    #[test]
    fn rejects_unknown_repeated_properties_extra_feeds_and_trailing_bytes() {
        let mut unknown = standard(1, 1);
        unknown.push((3, 5u16.to_le_bytes().to_vec())); // PublisherCount: not requested
        assert!(parse_pyth_lazer_payload(&payload(922, 1, &unknown)).is_err());
        let mut repeated = standard(1, 1);
        repeated.push((property::PRICE, 2i64.to_le_bytes().to_vec()));
        assert!(parse_pyth_lazer_payload(&payload(922, 1, &repeated)).is_err());
        let mut two_feeds = payload(922, 1, &standard(1, 1));
        two_feeds[13] = 2;
        assert!(parse_pyth_lazer_payload(&two_feeds).is_err());
        let mut trailing = payload(922, 1, &standard(1, 1));
        trailing.push(0);
        assert!(parse_pyth_lazer_payload(&trailing).is_err());
    }

    #[test]
    fn accepts_an_update_inside_the_close_window_with_tight_confidence() {
        // $254.12, confidence $0.10 ≈ 3.9 bps ≤ 5 bps.
        let r = reading(CLOSE * 1_000_000, 25_412_000_000, Some(10_000_000));
        let out = check_pyth_reading(&r, 922, &clock(9, CLOSE + 300), CLOSE, 60, 5).unwrap();
        assert_eq!(out.value_scaled, r.value_scaled);
        assert_eq!(out.slot, 9);
        // The window is anchored on the close: settling hours later with the close update works.
        assert!(check_pyth_reading(&r, 922, &clock(9, CLOSE + 86_400), CLOSE, 60, 5).is_ok());
    }

    /// The Anchor error code number of a failed check.
    fn code(result: Result<CloseReading>) -> u32 {
        match result.unwrap_err() {
            anchor_lang::error::Error::AnchorError(error) => error.error_code_number,
            other => panic!("not an Anchor error: {other:?}"),
        }
    }

    #[test]
    fn each_rule_has_its_own_error() {
        let now = clock(9, CLOSE + 300);
        let good = reading(CLOSE * 1_000_000, 25_412_000_000, Some(10_000_000));
        assert_eq!(
            code(check_pyth_reading(&good, 954, &now, CLOSE, 60, 5)),
            u32::from(MeridianError::OracleFeedHashMismatch)
        );
        let early = reading((CLOSE - 1) * 1_000_000, 25_412_000_000, Some(1));
        assert_eq!(
            code(check_pyth_reading(&early, 922, &now, CLOSE, 60, 5)),
            u32::from(MeridianError::OracleBeforeClose)
        );
        let late = reading((CLOSE + 61) * 1_000_000, 25_412_000_000, Some(1));
        assert_eq!(
            code(check_pyth_reading(&late, 922, &now, CLOSE, 60, 5)),
            u32::from(MeridianError::PythAfterCloseWindow)
        );
        let future = reading((CLOSE + 30) * 1_000_000, 25_412_000_000, Some(1));
        assert_eq!(
            code(check_pyth_reading(
                &future,
                922,
                &clock(9, CLOSE + 10),
                CLOSE,
                60,
                5
            )),
            u32::from(MeridianError::OracleInvalidValue)
        );
        // 5 bps of $254.12 is 12_706_000 in 1e-8 units: one more is too wide.
        let wide = reading(CLOSE * 1_000_000, 25_412_000_000, Some(12_706_001));
        assert_eq!(
            code(check_pyth_reading(&wide, 922, &now, CLOSE, 60, 5)),
            u32::from(MeridianError::PythConfidenceTooWide)
        );
        let edge = reading(CLOSE * 1_000_000, 25_412_000_000, Some(12_706_000));
        assert!(check_pyth_reading(&edge, 922, &now, CLOSE, 60, 5).is_ok());
        let missing = reading(CLOSE * 1_000_000, 25_412_000_000, None);
        assert_eq!(
            code(check_pyth_reading(&missing, 922, &now, CLOSE, 60, 5)),
            u32::from(MeridianError::PythConfidenceTooWide)
        );
        let zero_ts = reading(0, 25_412_000_000, Some(1));
        assert_eq!(
            code(check_pyth_reading(&zero_ts, 922, &now, 0, 60, 5)),
            u32::from(MeridianError::OracleInvalidValue)
        );
        let negative = reading(CLOSE * 1_000_000, -1, Some(1));
        assert_eq!(
            code(check_pyth_reading(&negative, 922, &now, CLOSE, 60, 5)),
            u32::from(MeridianError::OracleInvalidValue)
        );
    }

    #[test]
    fn scales_both_ways() {
        assert_eq!(scale_to_18(123, -2).unwrap(), 123 * 10i128.pow(16));
        assert_eq!(scale_to_18(5, 0).unwrap(), 5 * 10i128.pow(18));
        assert_eq!(scale_to_18(1_000, -20).unwrap(), 10);
        assert!(scale_to_18(i64::MAX, 30).is_err());
    }
}
