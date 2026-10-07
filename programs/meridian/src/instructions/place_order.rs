//! `place_order`: stub until M1-05. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{OrderKind, Side};
#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    /// The order owner.
    pub user: Signer<'info>,
}

pub fn handle_place_order(
    _ctx: Context<PlaceOrder>,
    _side: Side,
    _price: u8,
    _qty: u64,
    _kind: OrderKind,
) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
