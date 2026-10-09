//! `settle_market` (FR-08, D-030): permissionless settlement from the two oracle feeds pinned
//! in the config for the market's ticker (domain.md § Settlement rules) or from RedStone
//! (M2-15, D-054). Writes the outcome once; a settled market never changes (invariant 4, AB-08).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::events::MarketSettled;
use crate::oracle::{combine, read_close, read_redstone_price, yes_wins};
use crate::state::{
    Config, Market, MarketStatus, Outcome, OracleConfig, RedstonePrice, SettleSource, CONFIG_SEED,
    FEEDS_PER_TICKER, MARKET_SEED,
};

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
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
    /// Feed for source slot 0 (Tiingo). Owner, address and feed hash are checked against the
    /// config by the oracle adapter. Used for Switchboard path (M2-18 removes).
    /// CHECK: validated in `oracle::read_close`.
    pub feed_tiingo: UncheckedAccount<'info>,
    /// Feed for source slot 1 (Twelve Data). Checked like `feed_tiingo`. Switchboard path.
    /// CHECK: validated in `oracle::read_close`.
    pub feed_twelve_data: UncheckedAccount<'info>,
    /// RedStone verified price for this ticker (M2-15, D-054). Optional: if present, use
    /// RedStone path instead of Switchboard.
    /// CHECK: validated in `oracle::read_redstone_price`.
    pub redstone_price: Option<Account<'info, RedstonePrice>>,
    /// Oracle configuration with RedStone signer set. Required when using RedStone path.
    /// CHECK: PDA validated via seeds; only read if redstone_price is Some.
    pub oracle_config: Option<Account<'info, OracleConfig>>,
    /// Anyone: settlement is permissionless (D-030).
    pub payer: Signer<'info>,
}

pub fn handle_settle_market(ctx: Context<SettleMarket>) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;
    let market = &ctx.accounts.market;
    require!(
        market.status == MarketStatus::Open,
        MeridianError::AlreadySettled
    );
    require!(
        clock.unix_timestamp >= market.close_ts,
        MeridianError::NotClosed
    );

    // Detect oracle path: RedStone (D-054) if redstone_price is present, else Switchboard
    let (price, oracle_slot) = if let Some(redstone_price) = &ctx.accounts.redstone_price {
        // RedStone path (M2-15): single verified price, no combine
        let oracle_config = ctx
            .accounts
            .oracle_config
            .as_ref()
            .ok_or(MeridianError::RedStoneWrongPricePda)?;
        let reading = read_redstone_price(
            redstone_price,
            &market.ticker,
            &clock,
            market.close_ts,
            oracle_config.max_package_delay_secs,
            config.max_staleness_slots,
        )?;
        (reading.value_scaled, reading.slot)
    } else {
        // Switchboard path (until M2-18 removes): dual feeds + combine
        let ticker = config
            .ticker(&market.ticker)
            .ok_or(MeridianError::UnknownTicker)?;
        let feeds = [
            ctx.accounts.feed_tiingo.to_account_info(),
            ctx.accounts.feed_twelve_data.to_account_info(),
        ];
        let mut readings = Vec::with_capacity(FEEDS_PER_TICKER);
        for (index, feed) in feeds.iter().enumerate() {
            let key = ticker
                .feeds
                .get(index)
                .ok_or(MeridianError::InvalidTickerSlot)?;
            let hash = ticker
                .feed_hashes
                .get(index)
                .ok_or(MeridianError::InvalidTickerSlot)?;
            readings.push(read_close(
                feed,
                key,
                hash,
                &clock,
                market.close_ts,
                config.max_staleness_slots,
            )?);
        }
        let (first, second) = match readings.as_slice() {
            [first, second] => (first, second),
            _ => return Err(MeridianError::InvalidTickerSlot.into()),
        };
        let price = combine(first.value_scaled, second.value_scaled, config.max_conf_bps)?;
        // The older of the two slots is the conservative "oracle slot".
        let oracle_slot = first.slot.min(second.slot);
        (price, oracle_slot)
    };

    let outcome = if yes_wins(price, market.strike_cents)? {
        Outcome::Yes
    } else {
        Outcome::No
    };
    record_settlement(
        &mut ctx.accounts.market,
        outcome,
        price,
        oracle_slot,
        SettleSource::Oracle,
        clock.unix_timestamp,
    )
}

/// Writes the settlement record and emits `MarketSettled`; shared with `admin_settle_override`.
pub fn record_settlement(
    market: &mut Account<Market>,
    outcome: Outcome,
    price_scaled: i128,
    oracle_slot: u64,
    source: SettleSource,
    now: i64,
) -> Result<()> {
    require!(
        market.status == MarketStatus::Open,
        MeridianError::AlreadySettled
    );
    market.status = MarketStatus::Settled;
    market.outcome = outcome;
    market.settle_price_scaled = price_scaled;
    market.settle_slot = oracle_slot;
    market.settled_at = now;
    market.settle_source = source;
    emit!(MarketSettled {
        market: market.key(),
        outcome,
        price: price_scaled,
        source,
        oracle_slot,
    });
    Ok(())
}
