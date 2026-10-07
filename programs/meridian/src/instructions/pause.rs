//! `pause` (FR-11, D-030, AB-06): the admin sets the global pause flag. While paused,
//! `mint_pair`, new orders, `buy_no` and `sell_no` are rejected; cancel, `settle_funds`, redeem
//! and settlement keep working (domain.md § Market lifecycle and time rules). Idempotent.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::events::Paused;
use crate::state::{Config, CONFIG_SEED};

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::AdminOnly,
    )]
    pub config: Account<'info, Config>,
    /// The admin.
    pub admin: Signer<'info>,
}

pub fn handle_pause(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = true;
    emit!(Paused {
        admin: config.admin
    });
    Ok(())
}
