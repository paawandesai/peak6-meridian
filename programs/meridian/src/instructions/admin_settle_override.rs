//! `admin_settle_override` (FR-09, D-026): the admin settles with a manual price once
//! `close_ts + override_delay_secs` has passed and the oracle still has not settled the market.
//! Same one-way write as `settle_market`, with source = Override (AB-07, AB-08).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::instructions::settle_market::record_settlement;
use crate::oracle::{cents_to_scaled, yes_wins};
use crate::state::{Config, Market, MarketStatus, Outcome, SettleSource, CONFIG_SEED, MARKET_SEED};

#[derive(Accounts)]
pub struct AdminSettleOverride<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ MeridianError::AdminOnly)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [
            MARKET_SEED,
            &market.ticker,
            &market.trading_date.to_le_bytes(),
            &market.strike_cents.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,
    /// The admin.
    pub admin: Signer<'info>,
}

pub fn handle_admin_settle_override(
    ctx: Context<AdminSettleOverride>,
    settle_price_cents: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &ctx.accounts.market;
    require!(
        market.status == MarketStatus::Open,
        MeridianError::AlreadySettled
    );
    let delay = i64::try_from(ctx.accounts.config.override_delay_secs)
        .map_err(|_| MeridianError::MathOverflow)?;
    let allowed_from = market
        .close_ts
        .checked_add(delay)
        .ok_or(MeridianError::MathOverflow)?;
    require!(now >= allowed_from, MeridianError::OverrideTooEarly);
    require!(settle_price_cents > 0, MeridianError::OracleInvalidValue);

    let price = cents_to_scaled(settle_price_cents)?;
    let outcome = if yes_wins(price, market.strike_cents)? {
        Outcome::Yes
    } else {
        Outcome::No
    };
    record_settlement(
        &mut ctx.accounts.market,
        outcome,
        price,
        0,
        SettleSource::Override,
        now,
    )
}
