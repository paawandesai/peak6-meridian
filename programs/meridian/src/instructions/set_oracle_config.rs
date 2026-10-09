//! `set_oracle_config`: admin sets the RedStone signer set and thresholds (M2-15, D-054).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{Config, OracleConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SetOracleConfigParams {
    /// Pinned RedStone signer set: Ethereum addresses (20 bytes each), up to 8.
    pub signers: Vec<[u8; 20]>,
    /// Minimum number of valid signers required (≥ 1, ≤ signers.len()).
    pub signer_threshold: u8,
    /// Maximum age in seconds for a RedStone package timestamp (default 600 s).
    pub max_package_delay_secs: i64,
}

#[derive(Accounts)]
pub struct SetOracleConfig<'info> {
    /// Admin signer (checked against Config.admin).
    pub admin: Signer<'info>,

    /// Config account (read-only, for admin check).
    #[account(
        seeds = [Config::SEED_PREFIX],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// OracleConfig PDA (created if it doesn't exist, updated if it does).
    #[account(
        init_if_needed,
        payer = admin,
        space = OracleConfig::SPACE,
        seeds = OracleConfig::SEEDS,
        bump,
    )]
    pub oracle_config: Account<'info, OracleConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handle_set_oracle_config(
    ctx: Context<SetOracleConfig>,
    params: SetOracleConfigParams,
) -> Result<()> {
    // Admin check
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.config.admin,
        MeridianError::AdminOnly
    );

    // Threshold validation
    require!(
        params.signer_threshold >= 1,
        MeridianError::OracleThresholdTooLow
    );
    require!(
        (params.signer_threshold as usize) <= params.signers.len(),
        MeridianError::OracleThresholdTooHigh
    );

    // TODO(M2-15): Full implementation - update OracleConfig account
    Err(MeridianError::NotImplemented.into())
}
