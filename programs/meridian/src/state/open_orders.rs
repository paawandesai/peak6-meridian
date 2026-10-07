//! Per-user, per-market balances owed from fills and cancels (D-029), withdrawn with
//! `settle_funds`.

use anchor_lang::prelude::*;

/// PDA seed of an [`OpenOrders`] account: `["oo", market, owner]`.
pub const OPEN_ORDERS_SEED: &[u8] = b"oo";

/// Free balances of one owner in one market. PDA seeds: `["oo", market, owner]`.
#[account]
#[derive(Debug, InitSpace)]
pub struct OpenOrders {
    /// The owner who can withdraw these balances.
    pub owner: Pubkey,
    /// The market these balances belong to.
    pub market: Pubkey,
    /// USDC base units withdrawable with `settle_funds`.
    pub free_usdc: u64,
    /// YES contracts withdrawable with `settle_funds`.
    pub free_yes: u64,
    /// Orders currently resting on the book for this owner (cap: 8).
    pub resting_count: u8,
    /// PDA bump.
    pub bump: u8,
}
