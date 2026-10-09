//! `post_redstone_price`: permissionless RedStone package verification and price posting (M2-15, D-054).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{OracleConfig, RedstonePrice, SYMBOL_LEN};

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

    // Verify signatures and collect valid signers
    let mut valid_values = Vec::new();
    let mut seen_signers = std::collections::HashSet::new();

    // All packages must have same timestamp and feed_id
    let expected_timestamp = packages[0].timestamp_ms;
    let expected_feed_id = packages[0].feed_id;

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

    // Check package timestamp not older than stored (if exists)
    let redstone_price = &mut ctx.accounts.redstone_price;
    if redstone_price.package_timestamp_ms > 0 {
        require!(
            expected_timestamp > redstone_price.package_timestamp_ms,
            MeridianError::RedStonePackageOlderThanStored
        );
    }

    // Update RedstonePrice account
    redstone_price.symbol = symbol;
    redstone_price.value = median_value;
    redstone_price.package_timestamp_ms = expected_timestamp;
    redstone_price.posted_slot = clock.slot;
    redstone_price.signer_count = seen_signers.len() as u8;

    Ok(())
}
