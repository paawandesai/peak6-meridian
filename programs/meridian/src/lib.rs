//! Meridian on-chain program: config, strike markets, pair mint/redeem, the YES-vs-USDC book,
//! settlement and pause. Rules: docs/domain.md; contracts: docs/architecture.md.
//!
//! Shared files (`state/`, `errors.rs`, `events.rs`, this file) are frozen by M1-02 (D-022);
//! each later ticket owns its `instructions/<name>.rs`.

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod oracle;
pub mod pyth;
pub mod state;

pub use instructions::*;
pub use state::*;

declare_id!("H8SBU6m8sGRvKudUGhroDP4oEMyvF9QDhVc9wTFESXSm");

#[program]
pub mod meridian {
    use super::*;

    /// Logs the crate version. Kept until M1-10: the e2e placeholder calls it.
    pub fn version(ctx: Context<Version>) -> Result<()> {
        instructions::version::handle_version(ctx)
    }

    /// Creates the config; the payer becomes the admin (FR-01).
    pub fn initialize_config(ctx: Context<InitializeConfig>, params: ConfigParams) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(ctx, params)
    }

    /// Admin replaces every configurable field except the admin itself (FR-01, AB-06).
    pub fn update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
        instructions::update_config::handle_update_config(ctx, params)
    }

    /// Automation authority creates one strike market (FR-02). Stub until M1-04.
    pub fn create_strike_market(
        ctx: Context<CreateStrikeMarket>,
        ticker: [u8; SYMBOL_LEN],
        strike_cents: u64,
        trading_date: u32,
        close_ts: i64,
    ) -> Result<()> {
        instructions::create_strike_market::handle_create_strike_market(
            ctx,
            ticker,
            strike_cents,
            trading_date,
            close_ts,
        )
    }

    /// Admin adds a strike before close (FR-03). Stub until M1-04.
    pub fn add_strike(
        ctx: Context<AddStrike>,
        ticker: [u8; SYMBOL_LEN],
        strike_cents: u64,
        trading_date: u32,
        close_ts: i64,
    ) -> Result<()> {
        instructions::add_strike::handle_add_strike(
            ctx,
            ticker,
            strike_cents,
            trading_date,
            close_ts,
        )
    }

    /// Deposits `qty` USDC and mints `qty` YES + `qty` NO (FR-04). Stub until M1-04.
    pub fn mint_pair(ctx: Context<MintPair>, qty: u64) -> Result<()> {
        instructions::mint_pair::handle_mint_pair(ctx, qty)
    }

    /// Places a YES bid or ask, limit or IOC (FR-05). Stub until M1-05.
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: Side,
        price: u8,
        qty: u64,
        kind: OrderKind,
    ) -> Result<()> {
        instructions::place_order::handle_place_order(ctx, side, price, qty, kind)
    }

    /// Cancels the owner's resting order (FR-05). Stub until M1-05.
    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
        instructions::cancel_order::handle_cancel_order(ctx, order_id)
    }

    /// Withdraws the owner's free balances (FR-12, D-029). Stub until M1-05.
    pub fn settle_funds(ctx: Context<SettleFunds>) -> Result<()> {
        instructions::settle_funds::handle_settle_funds(ctx)
    }

    /// Mint pair + sell YES (FR-06). Stub until M1-06.
    pub fn buy_no(ctx: Context<BuyNo>, qty: u64, price: u8, kind: OrderKind) -> Result<()> {
        instructions::buy_no::handle_buy_no(ctx, qty, price, kind)
    }

    /// IOC buy YES with a price cap + pair redeem (FR-07). Stub until M1-06.
    pub fn sell_no(ctx: Context<SellNo>, qty: u64, price: u8) -> Result<()> {
        instructions::sell_no::handle_sell_no(ctx, qty, price)
    }

    /// Permissionless settlement from the two oracle feeds (FR-08).
    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        instructions::settle_market::handle_settle_market(ctx)
    }

    /// Admin settlement with a manual price after the delay (FR-09).
    pub fn admin_settle_override(
        ctx: Context<AdminSettleOverride>,
        settle_price_cents: u64,
    ) -> Result<()> {
        instructions::admin_settle_override::handle_admin_settle_override(ctx, settle_price_cents)
    }

    /// Pair redeem before settlement, winner redeem after (FR-10).
    pub fn redeem(ctx: Context<Redeem>, yes_qty: u64, no_qty: u64) -> Result<()> {
        instructions::redeem::handle_redeem(ctx, yes_qty, no_qty)
    }

    /// Global pause (FR-11). Stub until M1-04.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::handle_pause(ctx)
    }

    /// Lifts the global pause (FR-11). Stub until M1-04.
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::unpause::handle_unpause(ctx)
    }

    /// Test-only oracle writer; never in devnet builds (D-028, AB-22).
    #[cfg(feature = "local-oracle")]
    pub fn local_oracle_set(
        ctx: Context<LocalOracleSet>,
        ticker: [u8; SYMBOL_LEN],
        source_slot: u8,
        value: i128,
        slot: u64,
    ) -> Result<()> {
        instructions::local_oracle_set::handle_local_oracle_set(
            ctx,
            ticker,
            source_slot,
            value,
            slot,
        )
    }
}
