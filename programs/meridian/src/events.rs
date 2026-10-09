//! Events: one per state change (FR-33). The list follows architecture.md § Interfaces, plus
//! the two config events required by CLAUDE.md ("emit an event for every state change").

use anchor_lang::prelude::*;

use crate::state::{Outcome, SettleSource, Side, SYMBOL_LEN};

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub automation_authority: Pubkey,
    pub usdc_mint: Pubkey,
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub automation_authority: Pubkey,
    pub usdc_mint: Pubkey,
}

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub ticker: [u8; SYMBOL_LEN],
    pub strike_cents: u64,
    pub trading_date: u32,
    pub close_ts: i64,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
}

#[event]
pub struct PairsMinted {
    pub market: Pubkey,
    pub user: Pubkey,
    pub qty: u64,
    pub pairs_outstanding: u64,
}

#[event]
pub struct OrderPlaced {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub order_id: u64,
    pub side: Side,
    pub price: u8,
    pub qty: u64,
    pub rested_qty: u64,
}

#[event]
pub struct OrderCancelled {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub order_id: u64,
    pub qty: u64,
}

#[event]
pub struct Fill {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub price: u8,
    pub qty: u64,
    pub taker_side: Side,
}

#[event]
pub struct FundsSettled {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub usdc: u64,
    pub yes: u64,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub outcome: Outcome,
    pub price: i128,
    pub source: SettleSource,
    pub oracle_slot: u64,
}

#[event]
pub struct Redeemed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub yes_qty: u64,
    pub no_qty: u64,
    pub usdc: u64,
}

#[event]
pub struct Paused {
    pub admin: Pubkey,
}

#[event]
pub struct Unpaused {
    pub admin: Pubkey,
}

#[event]
pub struct OracleConfigSet {
    pub signer_count: u8,
    pub signer_threshold: u8,
    pub max_package_delay_secs: i64,
}

#[event]
pub struct RedstonePricePosted {
    pub symbol: [u8; SYMBOL_LEN],
    pub value: u128,
    pub package_timestamp_ms: i64,
    pub posted_slot: u64,
    pub signer_count: u8,
}
