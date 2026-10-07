//! One market: a ticker, a strike and a trading date ("Will TICKER close at or above STRIKE
//! today?"), with its mints, vault, escrows, book and settlement record.

use anchor_lang::prelude::*;

use super::config::SYMBOL_LEN;

/// PDA seed prefix of a [`Market`]: `["market", symbol, trading_date_le, strike_cents_le]`.
pub const MARKET_SEED: &[u8] = b"market";
/// PDA seed of a market's YES mint: `["yes", market]`.
pub const YES_MINT_SEED: &[u8] = b"yes";
/// PDA seed of a market's NO mint: `["no", market]`.
pub const NO_MINT_SEED: &[u8] = b"no";
/// PDA seed of a market's collateral vault: `["vault", market]`.
pub const VAULT_SEED: &[u8] = b"vault";
/// PDA seed of a market's USDC book escrow: `["escrow_usdc", market]`.
pub const ESCROW_USDC_SEED: &[u8] = b"escrow_usdc";
/// PDA seed of a market's YES book escrow: `["escrow_yes", market]`.
pub const ESCROW_YES_SEED: &[u8] = b"escrow_yes";

/// Collateral behind one pair, in USDC base units (domain.md § Units).
pub const PAIR_COLLATERAL: u64 = 1_000_000;
/// USDC base units per contract per cent of price: cost of 1 contract at price p is p × this.
pub const BASE_UNITS_PER_CENT: u64 = 10_000;
/// Strikes are multiples of $10 (domain.md § Glossary), i.e. of this many cents.
pub const STRIKE_STEP_CENTS: u64 = 1_000;
/// Oracle values carry 18 fractional digits; strike cents are scaled by 10^16 to compare.
pub const STRIKE_CENTS_TO_SCALED: i128 = 10_000_000_000_000_000;

/// Lifecycle state stored on-chain. "Closed" is derived: `now ≥ close_ts` and not settled.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub enum MarketStatus {
    #[default]
    Open,
    Settled,
}

/// Binary outcome, written once at settlement and never changed (invariant 4).
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub enum Outcome {
    #[default]
    None,
    Yes,
    No,
}

/// Who settled the market.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub enum SettleSource {
    /// Not settled yet.
    #[default]
    None,
    /// `settle_market` from the two oracle feeds.
    Oracle,
    /// `admin_settle_override` after the on-chain delay.
    Override,
}

/// One strike market. PDA seeds: `["market", symbol, trading_date_le, strike_cents_le]`.
#[account]
#[derive(Debug, InitSpace)]
pub struct Market {
    /// Ticker symbol, zero-padded, as in [`super::Ticker::symbol`].
    pub ticker: [u8; SYMBOL_LEN],
    /// Strike in cents ($680 → 68,000); a multiple of [`STRIKE_STEP_CENTS`].
    pub strike_cents: u64,
    /// ET calendar date as `YYYYMMDD`.
    pub trading_date: u32,
    /// Close time, unix seconds (16:00 ET, or 13:00 ET on early-close days).
    pub close_ts: i64,
    /// YES mint (0 decimals, authority = this market).
    pub yes_mint: Pubkey,
    /// NO mint (0 decimals, authority = this market).
    pub no_mint: Pubkey,
    /// USDC vault holding pair collateral only: balance = 1,000,000 × `pairs_outstanding`.
    pub vault: Pubkey,
    /// USDC escrow of resting bids.
    pub escrow_usdc: Pubkey,
    /// YES escrow of resting asks and unsettled maker credits.
    pub escrow_yes: Pubkey,
    /// Zero-copy order book account.
    pub book: Pubkey,
    /// Pairs minted and not yet redeemed.
    pub pairs_outstanding: u64,
    /// `Open` or `Settled`.
    pub status: MarketStatus,
    /// `None` until settled.
    pub outcome: Outcome,
    /// Settle price with 18 fractional digits (oracle scale); 0 until settled.
    pub settle_price_scaled: i128,
    /// Oracle slot of the settle price (0 for overrides).
    pub settle_slot: u64,
    /// Unix timestamp of settlement; 0 until settled.
    pub settled_at: i64,
    /// `Oracle` or `Override` once settled.
    pub settle_source: SettleSource,
    /// PDA bump; the market signs for its mints and token accounts.
    pub bump: u8,
}
