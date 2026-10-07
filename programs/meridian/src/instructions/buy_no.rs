//! `buy_no`: stub until M1-06. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::OrderKind;
#[derive(Accounts)]
pub struct BuyNo<'info> {
    /// The user buying NO.
    pub user: Signer<'info>,
}

pub fn handle_buy_no(_ctx: Context<BuyNo>, _qty: u64, _price: u8, _kind: OrderKind) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
