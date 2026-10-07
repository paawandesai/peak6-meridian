//! `create_strike_market`: stub until M1-04. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::SYMBOL_LEN;
#[derive(Accounts)]
pub struct CreateStrikeMarket<'info> {
    /// The automation authority (D-030).
    pub automation_authority: Signer<'info>,
}

pub fn handle_create_strike_market(
    _ctx: Context<CreateStrikeMarket>,
    _ticker: [u8; SYMBOL_LEN],
    _strike_cents: u64,
    _trading_date: u32,
    _close_ts: i64,
) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
