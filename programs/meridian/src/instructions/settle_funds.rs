//! `settle_funds`: stub until M1-05. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct SettleFunds<'info> {
    /// The open orders owner.
    pub owner: Signer<'info>,
}

pub fn handle_settle_funds(_ctx: Context<SettleFunds>) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
