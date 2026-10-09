//! RedStone payload parser (M2-15).
//! Official RedStone Base/standard layout per @redstone-finance/protocol.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

/// RedStone marker: 9 bytes at the end of every payload (official: 0x000002ed57011e0000).
pub const REDSTONE_MARKER: [u8; 9] = [0x00, 0x00, 0x02, 0xed, 0x57, 0x01, 0x1e, 0x00, 0x00];

/// Maximum payload size to prevent DoS (16 KB).
pub const MAX_PAYLOAD_SIZE: usize = 16_384;

/// Feed ID size: 32 bytes.
const FEED_ID_SIZE: usize = 32;
/// Signature size: 65 bytes (r‖s‖v).
const SIGNATURE_SIZE: usize = 65;
/// Timestamp size: 6 bytes (milliseconds).
const TIMESTAMP_SIZE: usize = 6;
/// Data points count size: 3 bytes (official format).
const DATA_POINTS_COUNT_SIZE: usize = 3;
/// Data point value byte size field: 4 bytes (official format).
const DATA_POINT_VALUE_BYTE_SIZE_SIZE: usize = 4;
/// Data packages count size: 2 bytes.
const DATA_PACKAGES_COUNT_SIZE: usize = 2;
/// Unsigned metadata byte size field: 3 bytes (official format).
const UNSIGNED_METADATA_BYTE_SIZE_SIZE: usize = 3;

/// Parsed RedStone data package.
#[derive(Clone, Debug)]
pub struct RedstonePackage {
    /// Feed ID (32 bytes).
    pub feed_id: [u8; 32],
    /// Value (u256 big-endian, 8 decimals; stored as u128 per domain.md).
    pub value: u128,
    /// Package timestamp in milliseconds.
    pub timestamp_ms: i64,
    /// Signature (65 bytes r‖s‖v).
    pub signature: [u8; 65],
    /// Signable bytes for verification.
    pub signable_bytes: Vec<u8>,
}

/// Parse RedStone payload and extract data packages for a specific feed_id.
/// Official RedStone Base/standard layout: each package is independently signed.
pub fn parse_payload(payload: &[u8], target_feed_id: &[u8; 32]) -> Result<Vec<RedstonePackage>> {
    require!(
        payload.len() <= MAX_PAYLOAD_SIZE && payload.len() >= REDSTONE_MARKER.len(),
        MeridianError::RedStoneMalformedPayload
    );

    // Verify RedStone marker at end
    let marker_start = payload
        .len()
        .checked_sub(REDSTONE_MARKER.len())
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    require!(
        payload[marker_start..] == REDSTONE_MARKER,
        MeridianError::RedStoneMalformedPayload
    );

    // Parse backwards from marker
    let mut cursor = marker_start;

    // Unsigned metadata size (3 bytes, official format)
    cursor = cursor
        .checked_sub(UNSIGNED_METADATA_BYTE_SIZE_SIZE)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let metadata_size = read_u24_be(payload, cursor)?;
    cursor = cursor
        .checked_sub(metadata_size)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;

    // Data packages count (2 bytes)
    cursor = cursor
        .checked_sub(DATA_PACKAGES_COUNT_SIZE)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let packages_count = u16::from_be_bytes([
        *payload
            .get(cursor)
            .ok_or(MeridianError::RedStoneMalformedPayload)?,
        *payload
            .get(cursor.checked_add(1).ok_or(MeridianError::MathOverflow)?)
            .ok_or(MeridianError::RedStoneMalformedPayload)?,
    ]) as usize;
    require!(
        packages_count > 0 && packages_count <= 8,
        MeridianError::RedStoneMalformedPayload
    );

    // Parse each data package (independently signed)
    let mut packages = Vec::with_capacity(packages_count);
    for _ in 0..packages_count {
        let package = parse_data_package(payload, &mut cursor, target_feed_id)?;
        packages.push(package);
    }

    Ok(packages)
}

/// Parse a single data package (signature + data points + timestamp).
/// Each package is independently signed: signable_bytes = everything before the signature.
/// Searches for and extracts only the data point matching target_feed_id.
fn parse_data_package(
    payload: &[u8],
    cursor: &mut usize,
    target_feed_id: &[u8; 32],
) -> Result<RedstonePackage> {
    // Signature (65 bytes)
    *cursor = cursor
        .checked_sub(SIGNATURE_SIZE)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let sig_start = *cursor;
    let sig_end = sig_start
        .checked_add(SIGNATURE_SIZE)
        .ok_or(MeridianError::MathOverflow)?;
    let mut signature = [0u8; 65];
    signature.copy_from_slice(
        payload
            .get(sig_start..sig_end)
            .ok_or(MeridianError::RedStoneMalformedPayload)?,
    );

    let signable_end = sig_start; // Everything before signature is signable

    // Data points count (3 bytes, official format)
    *cursor = cursor
        .checked_sub(DATA_POINTS_COUNT_SIZE)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let dp_count = read_u24_be(payload, *cursor)?;
    require!(dp_count > 0, MeridianError::RedStoneMalformedPayload);
    require!(dp_count <= 10, MeridianError::RedStoneMalformedPayload); // Safety: cap at 10 data points

    // Data point value byte size (4 bytes, official format)
    *cursor = cursor
        .checked_sub(DATA_POINT_VALUE_BYTE_SIZE_SIZE)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let value_size = u32::from_be_bytes([
        *payload
            .get(*cursor)
            .ok_or(MeridianError::RedStoneMalformedPayload)?,
        *payload
            .get(cursor.checked_add(1).ok_or(MeridianError::MathOverflow)?)
            .ok_or(MeridianError::RedStoneMalformedPayload)?,
        *payload
            .get(cursor.checked_add(2).ok_or(MeridianError::MathOverflow)?)
            .ok_or(MeridianError::RedStoneMalformedPayload)?,
        *payload
            .get(cursor.checked_add(3).ok_or(MeridianError::MathOverflow)?)
            .ok_or(MeridianError::RedStoneMalformedPayload)?,
    ]) as usize;
    require!(value_size == 32, MeridianError::RedStoneMalformedPayload); // Only 32-byte u256 values

    // Timestamp (6 bytes)
    *cursor = cursor
        .checked_sub(TIMESTAMP_SIZE)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let ts_end = cursor
        .checked_add(TIMESTAMP_SIZE)
        .ok_or(MeridianError::MathOverflow)?;
    let ts = payload
        .get(*cursor..ts_end)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let timestamp_ms = i64::from_be_bytes([0, 0, ts[0], ts[1], ts[2], ts[3], ts[4], ts[5]]);

    // Parse all N data points, each is feed_id (32) + value (32)
    let data_point_size = FEED_ID_SIZE
        .checked_add(value_size)
        .ok_or(MeridianError::MathOverflow)?;
    let total_data_size = data_point_size
        .checked_mul(dp_count)
        .ok_or(MeridianError::MathOverflow)?;

    *cursor = cursor
        .checked_sub(total_data_size)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;

    let signable_start = *cursor;

    // Search for the data point matching target_feed_id
    // Real RedStone packages contain multiple feeds (BTC, ETH, SOL, etc.) under one signature
    let mut value = 0u128;
    let mut found = false;

    let mut dp_cursor = *cursor;
    for _ in 0..dp_count {
        // Read feed_id (32 bytes)
        let fid_end = dp_cursor
            .checked_add(FEED_ID_SIZE)
            .ok_or(MeridianError::MathOverflow)?;
        let fid = payload
            .get(dp_cursor..fid_end)
            .ok_or(MeridianError::RedStoneMalformedPayload)?;

        // Read value (32 bytes)
        let val_start = fid_end;
        let val_end = val_start
            .checked_add(value_size)
            .ok_or(MeridianError::MathOverflow)?;
        let val = payload
            .get(val_start..val_end)
            .ok_or(MeridianError::RedStoneMalformedPayload)?;

        // Check if this is the target feed_id
        if fid == target_feed_id && !found {
            // RedStone u256: validate high 16 bytes are zero (fail-closed per domain.md: stored as u128)
            if val[0..16].iter().any(|&b| b != 0) {
                return Err(MeridianError::RedStoneMalformedPayload.into());
            }
            // Extract last 16 bytes as u128 (RedStone uses 8 decimals)
            value = u128::from_be_bytes([
                val[16], val[17], val[18], val[19], val[20], val[21], val[22], val[23], val[24],
                val[25], val[26], val[27], val[28], val[29], val[30], val[31],
            ]);
            found = true;
        }

        dp_cursor = val_end;
    }

    // Require matching data point found
    require!(found, MeridianError::RedStoneFeedIdMismatch);

    // Signable bytes for THIS package only (independent signing)
    let signable_bytes = payload[signable_start..signable_end].to_vec();

    Ok(RedstonePackage {
        feed_id: *target_feed_id,
        value,
        timestamp_ms,
        signature,
        signable_bytes,
    })
}

/// Read 3-byte big-endian unsigned integer.
fn read_u24_be(data: &[u8], offset: usize) -> Result<usize> {
    let end = offset.checked_add(3).ok_or(MeridianError::MathOverflow)?;
    require!(end <= data.len(), MeridianError::RedStoneMalformedPayload);
    let bytes = data
        .get(offset..end)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    Ok(((bytes[0] as usize) << 16) | ((bytes[1] as usize) << 8) | (bytes[2] as usize))
}
