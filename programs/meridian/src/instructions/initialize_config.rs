//! `initialize_config` (FR-01): creates the single config PDA. The payer becomes the admin.
//! A second call fails because the PDA already exists. Ticker slots not listed stay empty
//! (at most 6 fit in one transaction; `update_config` writes the rest).

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::MeridianError;
use crate::events::ConfigInitialized;
use crate::state::{Config, ConfigParams, CONFIG_SEED};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    /// The deployer; becomes the admin.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// Test-USDC mint; must have 6 decimals (domain.md § Units).
    #[account(constraint = usdc_mint.decimals == 6 @ MeridianError::InvalidUsdcMint)]
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    params: ConfigParams,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.paused = false;
    config.bump = ctx.bumps.config;
    params.apply(config, ctx.accounts.usdc_mint.key())?;
    emit!(ConfigInitialized {
        admin: config.admin,
        automation_authority: config.automation_authority,
        usdc_mint: config.usdc_mint,
    });
    Ok(())
}
