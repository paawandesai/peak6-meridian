//! `redeem`: stub until M1-04 (pair mode) and M1-07 (winner mode). Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct Redeem<'info> {
    /// The user redeeming.
    pub user: Signer<'info>,
}

pub fn handle_redeem(_ctx: Context<Redeem>, _yes_qty: u64, _no_qty: u64) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
