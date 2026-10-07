//! `sell_no`: stub until M1-06. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct SellNo<'info> {
    /// The user selling NO.
    pub user: Signer<'info>,
}

pub fn handle_sell_no(_ctx: Context<SellNo>, _qty: u64, _price: u8) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
