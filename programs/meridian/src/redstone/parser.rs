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
        payload.len() <= MAX_PAYLOAD_SIZE,
        MeridianError::RedStoneMalformedPayload
    );

    // TODO(M2-15): Full parser implementation
    // 1. Verify REDSTONE_MARKER at end
    // 2. Parse unsigned metadata
    // 3. Parse signatures
    // 4. Parse data points
    // 5. Extract timestamp
    // 6. Build signable bytes for each package

    Err(MeridianError::NotImplemented.into())
}
