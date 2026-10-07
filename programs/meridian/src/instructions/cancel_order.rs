//! `cancel_order`: stub until M1-05. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    /// The order owner.
    pub owner: Signer<'info>,
}

pub fn handle_cancel_order(_ctx: Context<CancelOrder>, _order_id: u64) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
