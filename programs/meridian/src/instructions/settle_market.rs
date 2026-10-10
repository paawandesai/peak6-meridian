//! `settle_market` (FR-08, D-030, M3-10b): permissionless settlement from Pyth (primary, D-055),
//! RedStone (fallback), or the legacy Switchboard feeds. When both Pyth and RedStone are present,
//! the two-source spread check (D-033) is restored: both must be valid and within max_conf_bps.
//! Writes the outcome once; a settled market never changes (invariant 4, AB-08).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::errors::MeridianError;
use crate::events::MarketSettled;
use crate::oracle::{combine, read_close, read_redstone_price, yes_wins};
use crate::pyth;
use crate::state::{
    Config, Market, MarketStatus, OracleConfig, Outcome, RedstonePrice, SettleSource, CONFIG_SEED,
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
    /// RedStone verified price for this ticker (M2-15, D-054). Optional: used as fallback when
    /// Pyth is not present, or for two-source spread check when both Pyth and RedStone are present.
    /// AB-04: PDA seeds constraint ensures this is the price account for market.ticker.
    #[account(
        seeds = [RedstonePrice::SEED_PREFIX, &market.ticker],
        bump,
    )]
    pub redstone_price: Option<Account<'info, RedstonePrice>>,
    /// Oracle configuration with RedStone signer set. Required when using RedStone path.
    /// AB-04: PDA seeds constraint ensures this is the canonical oracle config.
    #[account(
        seeds = [b"oracle_config"],
        bump,
    )]
    pub oracle_config: Option<Account<'info, OracleConfig>>,
    /// Instructions sysvar (M3-10b, D-055). Required for Pyth Lazer path to validate the
    /// Ed25519Program signature verification instruction.
    /// CHECK: address checked against sysvar::instructions::ID.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: Option<UncheckedAccount<'info>>,
    /// Anyone: settlement is permissionless (D-030).
    pub payer: Signer<'info>,
}

pub fn handle_settle_market(
    ctx: Context<SettleMarket>,
    ed25519_ix_index: Option<u16>,
) -> Result<()> {
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

    // Determine ticker index for Pyth feed lookup
    let ticker_index = config
        .tickers
        .iter()
        .position(|t| !t.is_empty() && t.symbol == market.ticker)
        .ok_or(MeridianError::UnknownTicker)?;
    let pyth_feed_id = *config
        .pyth_feed_ids
        .get(ticker_index)
        .ok_or(MeridianError::UnknownTicker)?;

    // Oracle path priority (D-055): Pyth PRIMARY, RedStone fallback, Switchboard legacy
    let has_pyth = ctx.accounts.instructions_sysvar.is_some()
        && ed25519_ix_index.is_some()
        && pyth_feed_id != 0;
    let has_redstone = ctx.accounts.redstone_price.is_some();

    let (price, oracle_slot) = if has_pyth && has_redstone {
        // Both Pyth and RedStone present: two-source spread check (D-033, D-055)
        let pyth_reading = read_pyth_price(
            ctx.accounts.instructions_sysvar.as_ref().unwrap(),
            ed25519_ix_index.unwrap(),
            &config.pyth_lazer_signer,
            pyth_feed_id,
            &clock,
            market.close_ts,
            config.pyth_max_age_secs,
        )?;
        let oracle_config = ctx
            .accounts
            .oracle_config
            .as_ref()
            .ok_or(MeridianError::RedStoneWrongPricePda)?;
        let redstone_reading = read_redstone_price(
            ctx.accounts.redstone_price.as_ref().unwrap(),
            &market.ticker,
            &clock,
            market.close_ts,
            oracle_config.max_package_delay_secs,
            config.max_staleness_slots,
        )?;
        // Combine with spread check: both must be within max_conf_bps
        let price =
            combine(pyth_reading.value_scaled, redstone_reading.value_scaled, config.max_conf_bps)?;
        let oracle_slot = pyth_reading.slot.min(redstone_reading.slot);
        (price, oracle_slot)
    } else if has_pyth {
        // Pyth only (PRIMARY path, D-055)
        let reading = read_pyth_price(
            ctx.accounts.instructions_sysvar.as_ref().unwrap(),
            ed25519_ix_index.unwrap(),
            &config.pyth_lazer_signer,
            pyth_feed_id,
            &clock,
            market.close_ts,
            config.pyth_max_age_secs,
        )?;
        (reading.value_scaled, reading.slot)
    } else if has_redstone {
        // RedStone only (fallback, D-055)
        let oracle_config = ctx
            .accounts
            .oracle_config
            .as_ref()
            .ok_or(MeridianError::RedStoneWrongPricePda)?;
        let reading = read_redstone_price(
            ctx.accounts.redstone_price.as_ref().unwrap(),
            &market.ticker,
            &clock,
            market.close_ts,
            oracle_config.max_package_delay_secs,
            config.max_staleness_slots,
        )?;
        (reading.value_scaled, reading.slot)
    } else {
        // Switchboard path (legacy, until M2-18 removes): dual feeds + combine
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

/// Reads a Pyth Lazer price from the Ed25519 sysvar instruction and validates it.
fn read_pyth_price(
    instructions_sysvar: &UncheckedAccount,
    ed25519_ix_index: u16,
    pinned_signer: &Pubkey,
    expected_feed_id: u32,
    clock: &Clock,
    close_ts: i64,
    max_age_secs: i64,
) -> Result<crate::oracle::CloseReading> {
    pyth::read_pyth_lazer_close(
        &instructions_sysvar.to_account_info(),
        ed25519_ix_index,
        pinned_signer,
        expected_feed_id,
        clock,
        close_ts,
        max_age_secs,
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
