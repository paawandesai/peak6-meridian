//! Global configuration: authorities, the test-USDC mint, pause flag, settlement parameters and
//! the ticker list with its pinned oracle feeds.

use anchor_lang::prelude::*;

/// Number of tickers in the config (MAG7, domain.md § Glossary).
pub const TICKER_COUNT: usize = 7;
/// Length of the zero-padded ticker symbol.
pub const SYMBOL_LEN: usize = 8;
/// Number of oracle feeds per ticker: one per data source (Tiingo, Twelve Data).
pub const FEEDS_PER_TICKER: usize = 2;
/// Default `max_staleness_slots` (domain.md § Settlement rules): ≈ 12 s.
pub const DEFAULT_MAX_STALENESS_SLOTS: u64 = 30;
/// Default `max_conf_bps`: 5 bps = 0.05 %.
pub const DEFAULT_MAX_CONF_BPS: u16 = 5;
/// Default `override_delay_secs`: one hour after close.
pub const DEFAULT_OVERRIDE_DELAY_SECS: u64 = 3_600;
/// Basis points in 100 %.
pub const BPS_DENOMINATOR: u16 = 10_000;

/// PDA seed of the single [`Config`] account.
pub const CONFIG_SEED: &[u8] = b"config";

/// A ticker and its two oracle feeds (one per data source), pinned by feed hash.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct Ticker {
    /// Upper-case ASCII symbol, zero-padded (e.g. `b"META\0\0\0\0"`).
    pub symbol: [u8; SYMBOL_LEN],
    /// Switchboard feed accounts, index 0 = Tiingo, index 1 = Twelve Data.
    pub feeds: [Pubkey; FEEDS_PER_TICKER],
    /// Feed hashes pinned for the accounts above, same order.
    pub feed_hashes: [[u8; 32]; FEEDS_PER_TICKER],
}

impl Ticker {
    /// The symbol without its zero padding.
    pub fn symbol_bytes(&self) -> &[u8] {
        let end = self
            .symbol
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(SYMBOL_LEN);
        &self.symbol[..end]
    }

    /// True for an unset slot (all-zero symbol).
    pub fn is_empty(&self) -> bool {
        self.symbol == [0u8; SYMBOL_LEN]
    }

    /// True when the symbol is non-empty, upper-case ASCII and zero-padded only at the end.
    pub fn has_valid_symbol(&self) -> bool {
        let symbol = self.symbol_bytes();
        let padding = &self.symbol[symbol.len()..];
        !symbol.is_empty()
            && symbol.iter().all(|byte| byte.is_ascii_uppercase())
            && padding.iter().all(|byte| *byte == 0)
    }
}

/// Global program configuration. PDA seeds: `["config"]`.
#[account]
#[derive(Debug, InitSpace)]
pub struct Config {
    /// Admin: config updates, pause, add strike, settlement override (D-026, D-030).
    pub admin: Pubkey,
    /// Creates the daily strike markets; can do nothing else (AB-19).
    pub automation_authority: Pubkey,
    /// Test-USDC mint (6 decimals) used as collateral everywhere.
    pub usdc_mint: Pubkey,
    /// Global pause: blocks minting, new orders, `buy_no` and `sell_no` only.
    pub paused: bool,
    /// Oracle values older than this many slots are rejected at settlement.
    pub max_staleness_slots: u64,
    /// Maximum spread between the two oracle values, in basis points of their mean.
    pub max_conf_bps: u16,
    /// Seconds after `close_ts` before `admin_settle_override` is allowed.
    pub override_delay_secs: u64,
    /// The MAG7 tickers with their feeds; unset slots have an all-zero symbol.
    pub tickers: [Ticker; TICKER_COUNT],
    /// PDA bump.
    pub bump: u8,
    // ---- v2 (M3-10b): appended after `bump` so a v1 account is a byte-for-byte prefix of a
    // v2 one; `migrate_config` grows the v1 devnet account in place and zero-fills these. ----
    /// Pyth Lazer Ed25519 signer pubkey (D-055, M3-10b). Operator-controlled, never
    /// hard-trusted from payload. Used to verify Pyth signed price updates.
    pub pyth_lazer_signer: Pubkey,
    /// Pyth feed IDs for MAG7 tickers, in the same order as `tickers`. Each u32 is the
    /// numeric Pyth Pro feed ID. Zero means no Pyth feed configured for that ticker slot.
    pub pyth_feed_ids: [u32; TICKER_COUNT],
    /// Close window for Pyth updates, in seconds (D-055): `settle_market` accepts a signed
    /// update only if it was taken in `[close_ts, close_ts + pyth_max_age_secs]`. Anchored on
    /// the close, not on the current time, so a permissionless settler cannot pick a later
    /// after-hours price. The name is kept from the v2 layout.
    pub pyth_max_age_secs: i64,
}

/// Bytes of the Pyth fields appended in v2: signer (32) + feed ids (7 × 4) + max age (8).
pub const CONFIG_PYTH_FIELDS_LEN: usize = 32 + 4 * TICKER_COUNT + 8;
/// Size of the current (v2) Config account, discriminator included.
pub const CONFIG_LEN: usize = 8 + Config::INIT_SPACE;
/// Size of the v1 Config account (before M3-10b), discriminator included: the devnet account
/// created by M2-01 (1,076 bytes).
pub const CONFIG_V1_LEN: usize = CONFIG_LEN - CONFIG_PYTH_FIELDS_LEN;
/// Offset of `admin` in both layouts (right after the discriminator).
pub const CONFIG_ADMIN_OFFSET: usize = 8;
/// Offset of `bump`: the last byte of a v1 account, unchanged in v2.
pub const CONFIG_BUMP_OFFSET: usize = CONFIG_V1_LEN - 1;

// The migration relies on these exact sizes; a layout change must fail the build, not devnet.
const _: () = assert!(CONFIG_V1_LEN == 1_076);
const _: () = assert!(CONFIG_LEN == 1_144);

/// The Pyth fields `migrate_config` may set while it grows a v1 account (M3-10b). `None`
/// leaves them zeroed for a later `update_config`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythConfigParams {
    pub pyth_lazer_signer: Pubkey,
    pub pyth_feed_ids: [u32; TICKER_COUNT],
    pub pyth_max_age_secs: i64,
}

impl Config {
    /// The ticker whose symbol equals `symbol` (zero-padded), if any; empty slots never match.
    pub fn ticker(&self, symbol: &[u8; SYMBOL_LEN]) -> Option<&Ticker> {
        self.tickers
            .iter()
            .find(|ticker| !ticker.is_empty() && ticker.symbol == *symbol)
    }
}

/// One ticker slot to write: `index` is the position in [`Config::tickers`].
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct TickerSlot {
    pub index: u8,
    pub ticker: Ticker,
}

/// Ticker slots one call can carry while the transaction stays under the 1,232-byte packet
/// limit (a `Ticker` is 136 bytes; all seven would need 952 bytes of arguments alone).
pub const MAX_TICKER_SLOTS_PER_CALL: usize = 6;

/// Every configurable field (everything except `admin` and `paused`), as taken by
/// `initialize_config` and `update_config`. `usdc_mint` is passed as an account so its decimals
/// can be checked. Ticker slots not listed keep their value (empty after `initialize_config`);
/// a full set of seven therefore takes `initialize_config` plus one `update_config`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ConfigParams {
    pub automation_authority: Pubkey,
    pub max_staleness_slots: u64,
    pub max_conf_bps: u16,
    pub override_delay_secs: u64,
    pub tickers: Vec<TickerSlot>,
    pub pyth_lazer_signer: Pubkey,
    pub pyth_feed_ids: [u32; TICKER_COUNT],
    pub pyth_max_age_secs: i64,
}

impl ConfigParams {
    /// The ticker array that applying these parameters over `current` would produce, or the
    /// domain rule it would break (FR-01).
    pub fn merged_tickers(
        &self,
        current: &[Ticker; TICKER_COUNT],
    ) -> Result<[Ticker; TICKER_COUNT]> {
        use crate::errors::MeridianError;

        require!(
            self.max_staleness_slots > 0,
            MeridianError::InvalidMaxStaleness
        );
        require!(
            self.max_conf_bps > 0 && self.max_conf_bps <= BPS_DENOMINATOR,
            MeridianError::InvalidMaxConfBps
        );
        require!(
            self.tickers.len() <= MAX_TICKER_SLOTS_PER_CALL,
            MeridianError::TooManyTickerSlots
        );
        let mut merged = *current;
        for (position, slot) in self.tickers.iter().enumerate() {
            let index = usize::from(slot.index);
            require!(index < TICKER_COUNT, MeridianError::InvalidTickerSlot);
            require!(
                !self.tickers[..position]
                    .iter()
                    .any(|earlier| earlier.index == slot.index),
                MeridianError::DuplicateTickerSlot
            );
            require!(
                slot.ticker.has_valid_symbol(),
                MeridianError::InvalidTickerSymbol
            );
            if let Some(target) = merged.get_mut(index) {
                *target = slot.ticker;
            }
        }
        for (index, ticker) in merged.iter().enumerate() {
            if ticker.is_empty() {
                continue;
            }
            let duplicate = merged[..index]
                .iter()
                .any(|earlier| earlier.symbol == ticker.symbol);
            require!(!duplicate, MeridianError::DuplicateTickerSymbol);
        }
        Ok(merged)
    }

    /// Validates against the current config and writes every field; `admin`, `paused` and
    /// `bump` are untouched. Nothing is written when validation fails.
    pub fn apply(&self, config: &mut Config, usdc_mint: Pubkey) -> Result<()> {
        use crate::errors::MeridianError;

        let tickers = self.merged_tickers(&config.tickers)?;
        require!(self.pyth_max_age_secs > 0, MeridianError::InvalidPythMaxAge);
        config.automation_authority = self.automation_authority;
        config.usdc_mint = usdc_mint;
        config.max_staleness_slots = self.max_staleness_slots;
        config.max_conf_bps = self.max_conf_bps;
        config.override_delay_secs = self.override_delay_secs;
        config.tickers = tickers;
        config.pyth_lazer_signer = self.pyth_lazer_signer;
        config.pyth_feed_ids = self.pyth_feed_ids;
        config.pyth_max_age_secs = self.pyth_max_age_secs;
        Ok(())
    }
}
