//! Oracle configuration: RedStone signer set and thresholds (M2-15, D-054).

use anchor_lang::prelude::*;

/// Maximum number of RedStone signers in the pinned set.
pub const MAX_SIGNERS: usize = 8;

/// Oracle configuration PDA `["oracle_config"]`: pinned RedStone signer set and thresholds.
/// Separate from `Config` so the live Config account layout is unchanged.
#[account]
#[derive(Debug, PartialEq, Eq)]
pub struct OracleConfig {
    /// Pinned RedStone signer set: Ethereum addresses (20 bytes each), up to 8.
    /// A signer not in this set is ignored; an unknown signer does not cause rejection.
    pub signers: Vec<[u8; 20]>,
    /// Minimum number of valid signers required for a RedStone package to be accepted (≥ 1, ≤ signers.len()).
    pub signer_threshold: u8,
    /// Maximum age in seconds for a RedStone package timestamp (default 600 s = 10 min).
    /// A package timestamp after `close_ts + max_package_delay_secs` is rejected.
    pub max_package_delay_secs: i64,
}

impl OracleConfig {
    /// Space: 8 (discriminator) + 4 (vec len) + 8*20 (signers) + 1 (threshold) + 8 (delay).
    pub const SPACE: usize = 8 + 4 + (MAX_SIGNERS * 20) + 1 + 8;

    /// PDA seeds.
    pub const SEEDS: &'static [&'static [u8]] = &[b"oracle_config"];
}
