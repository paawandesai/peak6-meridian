//! `unpause` (FR-11, D-030, AB-06): the admin clears the global pause flag. Idempotent.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::events::Unpaused;
use crate::state::{Config, CONFIG_SEED};

#[derive(Accounts)]
pub struct Unpause<'info> {
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

pub fn handle_unpause(ctx: Context<Unpause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = false;
    emit!(Unpaused {
        admin: config.admin
    });
    Ok(())
}
