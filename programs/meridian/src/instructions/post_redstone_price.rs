//! `post_redstone_price`: permissionless RedStone package verification and price posting (M2-15, D-054).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{Market, OracleConfig, RedstonePrice, MARKET_SEED, SYMBOL_LEN};

#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN])]
pub struct PostRedstonePrice<'info> {
    /// Payer for the RedstonePrice account if it doesn't exist yet.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// OracleConfig PDA (read-only, for signer set and threshold).
    #[account(
        seeds = [b"oracle_config"],
        bump,
    )]
    pub oracle_config: Account<'info, OracleConfig>,

    /// Market PDA (read-only, for close_ts window validation; AB-03 liveness).
    /// Must match the symbol being posted. Seeds constrained per settle_market pattern.
    #[account(
        seeds = [
            MARKET_SEED,
            market.ticker.as_ref(),
            &market.trading_date.to_le_bytes(),
            &market.strike_cents.to_le_bytes(),
        ],
        bump,
    )]
    pub market: Account<'info, Market>,

    /// RedstonePrice PDA for this ticker (created if it doesn't exist, updated if it does).
    #[account(
        init_if_needed,
        payer = payer,
        space = RedstonePrice::SPACE,
        seeds = [RedstonePrice::SEED_PREFIX, &symbol],
        bump,
    )]
    pub redstone_price: Account<'info, RedstonePrice>,

    pub system_program: Program<'info, System>,
}

pub fn handle_post_redstone_price(
    ctx: Context<PostRedstonePrice>,
    symbol: [u8; SYMBOL_LEN],
    payload: Vec<u8>,
) -> Result<()> {
    use crate::redstone::{compute_median, parse_payload, verify_signature};

    // Parse RedStone payload
    let packages = parse_payload(&payload)?;

    let oracle_config = &ctx.accounts.oracle_config;
    let clock = Clock::get()?;

    // All packages must have same timestamp and feed_id
    let expected_timestamp = packages[0].timestamp_ms;
    let expected_feed_id = packages[0].feed_id;

    // AB-04: Validate feed_id matches the canonical feed_id for this symbol.
    // Canonical feed_id: symbol bytes right-padded with zeros to 32 bytes.
    let canonical_feed_id = symbol_to_feed_id(&symbol);
    require!(
        expected_feed_id == canonical_feed_id,
        MeridianError::RedStoneFeedIdMismatch
    );

    // Verify signatures and collect valid signers
    let mut valid_values = Vec::new();
    let mut seen_signers = std::collections::HashSet::new();

    for package in &packages {
        // Verify same timestamp and feed_id across all packages
        require!(
            package.timestamp_ms == expected_timestamp && package.feed_id == expected_feed_id,
            MeridianError::RedStoneMalformedPayload
        );

        // Verify signature and recover Ethereum address
        let eth_address = verify_signature(package)?;

        // Check if signer is in pinned set
        let is_pinned = oracle_config.signers.iter().any(|s| s == &eth_address);

        // Count signer only if: in pinned set AND not already counted (dedup)
        if is_pinned && !seen_signers.contains(&eth_address) {
            seen_signers.insert(eth_address);
            valid_values.push(package.value);
        }
    }

    // Check threshold
    require!(
        valid_values.len() >= oracle_config.signer_threshold as usize,
        MeridianError::RedStoneInsufficientSigners
    );

    // Compute median value
    let median_value = compute_median(valid_values);

    // AB-03 liveness: validate package against settlement window
    let market = &ctx.accounts.market;
    let redstone_price = &mut ctx.accounts.redstone_price;

    // Verify market ticker matches symbol
    require!(market.ticker == symbol, MeridianError::UnknownTicker);

    // Calculate settlement window: [close_ts, close_ts + max_package_delay_secs]
    let close_ts_ms = market
        .close_ts
        .checked_mul(1_000)
        .ok_or(MeridianError::MathOverflow)?;
    let delay_ms = oracle_config
        .max_package_delay_secs
        .checked_mul(1_000)
        .ok_or(MeridianError::MathOverflow)?;
    let window_end_ms = close_ts_ms
        .checked_add(delay_ms)
        .ok_or(MeridianError::MathOverflow)?;

    // New package must be within settlement window
    require!(
        expected_timestamp >= close_ts_ms,
        MeridianError::OracleBeforeClose
    );
    require!(
        expected_timestamp <= window_end_ms,
        MeridianError::RedStonePackageTooLate
    );

    // Never replace stored value with older package (AB-03: prevents historical-market attack)
    if redstone_price.package_timestamp_ms > 0 {
        require!(
            expected_timestamp >= redstone_price.package_timestamp_ms,
            MeridianError::RedStonePackageOlderThanStored
        );
    }

    // Update RedstonePrice account
    redstone_price.symbol = symbol;
    redstone_price.value = median_value;
    redstone_price.package_timestamp_ms = expected_timestamp;
    redstone_price.posted_slot = clock.slot;
    redstone_price.signer_count = seen_signers.len() as u8;

    emit!(crate::events::RedstonePricePosted {
        symbol,
        value: median_value,
        package_timestamp_ms: expected_timestamp,
        posted_slot: clock.slot,
        signer_count: seen_signers.len() as u8,
    });

    Ok(())
}

/// Compute canonical feed_id for a symbol (AB-04).
/// RedStone feed IDs are 32-byte arrays, typically UTF-8 ticker symbols right-padded with zeros.
fn symbol_to_feed_id(symbol: &[u8; SYMBOL_LEN]) -> [u8; 32] {
    let mut feed_id = [0u8; 32];
    feed_id[..SYMBOL_LEN].copy_from_slice(symbol);
    feed_id
}
