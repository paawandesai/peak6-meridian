//! `add_strike`: stub until M1-04. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::SYMBOL_LEN;
#[derive(Accounts)]
pub struct AddStrike<'info> {
    /// The admin.
    pub admin: Signer<'info>,
}

pub fn handle_add_strike(
    _ctx: Context<AddStrike>,
    _ticker: [u8; SYMBOL_LEN],
    _strike_cents: u64,
    _trading_date: u32,
    _close_ts: i64,
) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
