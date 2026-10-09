//! RedStone payload parser (M2-15).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

/// RedStone marker: 9 bytes at the end of every payload.
pub const REDSTONE_MARKER: [u8; 9] = [0x00, 0x00, 0x02, 0xed, 0x57, 0x19, 0x9a, 0x00, 0x00];

/// Maximum payload size to prevent DoS (16 KB).
pub const MAX_PAYLOAD_SIZE: usize = 16_384;

/// Data point size: 32 bytes (u256 value).
const DATA_POINT_VALUE_SIZE: usize = 32;
/// Feed ID size: 32 bytes.
const FEED_ID_SIZE: usize = 32;
/// Signature size: 65 bytes (r‖s‖v).
const SIGNATURE_SIZE: usize = 65;
/// Timestamp size: 6 bytes (milliseconds).
const TIMESTAMP_SIZE: usize = 6;

/// Parsed RedStone data package.
#[derive(Clone, Debug)]
pub struct RedstonePackage {
    /// Feed ID (32 bytes).
    pub feed_id: [u8; 32],
    /// Value (u256 big-endian, 8 decimals).
    pub value: u64,
    /// Package timestamp in milliseconds.
    pub timestamp_ms: i64,
    /// Signature (65 bytes r‖s‖v).
    pub signature: [u8; 65],
    /// Signable bytes for verification.
    pub signable_bytes: Vec<u8>,
}

/// Parse RedStone payload and extract data packages.
pub fn parse_payload(payload: &[u8]) -> Result<Vec<RedstonePackage>> {
    require!(
        payload.len() <= MAX_PAYLOAD_SIZE && payload.len() >= REDSTONE_MARKER.len(),
        MeridianError::RedStoneMalformedPayload
    );

    // Verify RedStone marker at end
    let marker_start = payload.len() - REDSTONE_MARKER.len();
    require!(
        &payload[marker_start..] == REDSTONE_MARKER,
        MeridianError::RedStoneMalformedPayload
    );

    // Parse backwards from marker
    let mut cursor = marker_start;

    // Unsigned metadata size (2 bytes)
    cursor = cursor
        .checked_sub(2)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let metadata_size = u16::from_be_bytes([payload[cursor], payload[cursor + 1]]) as usize;
    cursor = cursor
        .checked_sub(metadata_size)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;

    // Signature count
    cursor = cursor
        .checked_sub(2)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let sig_count = u16::from_be_bytes([payload[cursor], payload[cursor + 1]]) as usize;
    require!(
        sig_count > 0 && sig_count <= 8,
        MeridianError::RedStoneMalformedPayload
    );

    // Signatures
    let sigs_size = sig_count
        .checked_mul(SIGNATURE_SIZE)
        .ok_or(MeridianError::MathOverflow)?;
    cursor = cursor
        .checked_sub(sigs_size)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let signatures_start = cursor;

    // Timestamp (6 bytes)
    cursor = cursor
        .checked_sub(TIMESTAMP_SIZE)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let ts = &payload[cursor..cursor + TIMESTAMP_SIZE];
    let timestamp_ms = i64::from_be_bytes([0, 0, ts[0], ts[1], ts[2], ts[3], ts[4], ts[5]]);

    // Data point count
    cursor = cursor
        .checked_sub(2)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;
    let dp_count = u16::from_be_bytes([payload[cursor], payload[cursor + 1]]) as usize;
    require!(dp_count == 1, MeridianError::RedStoneMalformedPayload); // Simplification

    // Data point (feed_id + value)
    let dp_size = FEED_ID_SIZE + DATA_POINT_VALUE_SIZE;
    cursor = cursor
        .checked_sub(dp_size)
        .ok_or(MeridianError::RedStoneMalformedPayload)?;

    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&payload[cursor..cursor + FEED_ID_SIZE]);

    let val_start = cursor + FEED_ID_SIZE;
    let val = &payload[val_start..val_start + DATA_POINT_VALUE_SIZE];
    let value = u64::from_be_bytes([
        val[24], val[25], val[26], val[27], val[28], val[29], val[30], val[31],
    ]);

    // Signable bytes (everything before signatures)
    let signable_bytes = payload[..signatures_start].to_vec();

    // Build package per signature
    let mut packages = Vec::with_capacity(sig_count);
    for i in 0..sig_count {
        let sig_start = signatures_start + i * SIGNATURE_SIZE;
        let mut signature = [0u8; 65];
        signature.copy_from_slice(&payload[sig_start..sig_start + SIGNATURE_SIZE]);

        packages.push(RedstonePackage {
            feed_id,
            value,
            timestamp_ms,
            signature,
            signable_bytes: signable_bytes.clone(),
        });
    }

    Ok(packages)
}
