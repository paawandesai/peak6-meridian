//! RedStone verified price storage (M2-15, D-054).

use anchor_lang::prelude::*;

use crate::state::SYMBOL_LEN;

/// RedStone verified price PDA `["redstone_price", symbol]`: stores the most recent verified
/// RedStone package for a ticker after `post_redstone_price` verifies signatures and threshold.
#[account]
#[derive(Debug, PartialEq, Eq)]
pub struct RedstonePrice {
    /// Ticker symbol (8 bytes, zero-padded).
    pub symbol: [u8; SYMBOL_LEN],
    /// Price value with 8 decimals (RedStone format, u128 per domain.md).
    pub value: u128,
    /// Package timestamp in milliseconds (RedStone format).
    pub package_timestamp_ms: i64,
    /// Slot when this price was posted.
    pub posted_slot: u64,
    /// Number of valid signers in the verified package.
    pub signer_count: u8,
}

impl RedstonePrice {
    /// Space: 8 (discriminator) + 8 (symbol) + 16 (value) + 8 (timestamp) + 8 (slot) + 1 (count).
    pub const SPACE: usize = 8 + SYMBOL_LEN + 16 + 8 + 8 + 1;

    /// PDA seeds prefix (symbol is appended).
    pub const SEED_PREFIX: &'static [u8] = b"redstone_price";
}
