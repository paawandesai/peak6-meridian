//! `settle_market`: stub until M1-07. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    /// Anyone: settlement is permissionless (D-030).
    pub payer: Signer<'info>,
}

pub fn handle_settle_market(_ctx: Context<SettleMarket>) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
