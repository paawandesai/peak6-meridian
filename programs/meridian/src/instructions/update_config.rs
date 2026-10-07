//! `update_config` (FR-01, AB-06): the admin replaces every configurable field. The admin
//! itself and the pause flag are not part of the parameters; ticker slots not listed keep
//! their value.

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::MeridianError;
use crate::events::ConfigUpdated;
use crate::state::{Config, ConfigParams, CONFIG_SEED};

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::AdminOnly,
    )]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    /// Test-USDC mint; must have 6 decimals (domain.md § Units).
    #[account(constraint = usdc_mint.decimals == 6 @ MeridianError::InvalidUsdcMint)]
    pub usdc_mint: Account<'info, Mint>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
    let config = &mut ctx.accounts.config;
    params.apply(config, ctx.accounts.usdc_mint.key())?;
    emit!(ConfigUpdated {
        admin: config.admin,
        automation_authority: config.automation_authority,
        usdc_mint: config.usdc_mint,
    });
    Ok(())
}
