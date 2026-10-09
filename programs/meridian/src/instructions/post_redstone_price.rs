//! `post_redstone_price`: permissionless RedStone package verification and price posting (M2-15, D-054).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{OracleConfig, RedstonePrice, SYMBOL_LEN};

#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN])]
pub struct PostRedstonePrice<'info> {
    /// Payer for the RedstonePrice account if it doesn't exist yet.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// OracleConfig PDA (read-only, for signer set and threshold).
    #[account(
        seeds = OracleConfig::SEEDS,
        bump,
    )]
    pub oracle_config: Account<'info, OracleConfig>,

    /// RedstonePrice PDA for this ticker (created if it doesn't exist, updated if it does).
    #[account(
        init_if_needed,
        payer = payer,
        space = RedstonePrice::SPACE,
        seeds = [RedstonePrice::SEED_PREFIX, &symbol],
        bump,
    )]
    pub redstone_price: Account<'info, RedstonePrice>,

    pub system_program: Program<'info, System>,
}

pub fn handle_post_redstone_price(
    _ctx: Context<PostRedstonePrice>,
    _symbol: [u8; SYMBOL_LEN],
    _payload: Vec<u8>,
) -> Result<()> {
    // TODO(M2-15): Full implementation
    // 1. Parse RedStone payload (data packages, signatures, timestamp, feed id, value)
    // 2. Verify each signature with secp256k1_recover syscall
    // 3. Count valid signers (in pinned set, same timestamp, same feed id)
    // 4. Check threshold
    // 5. Compute median of valid signers' values
    // 6. Verify package timestamp is not older than stored value
    // 7. Update RedstonePrice account
    Err(MeridianError::NotImplemented.into())
}
