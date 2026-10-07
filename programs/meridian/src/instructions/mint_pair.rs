//! `mint_pair`: stub until M1-04. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct MintPair<'info> {
    /// The user depositing USDC.
    pub user: Signer<'info>,
}

pub fn handle_mint_pair(_ctx: Context<MintPair>, _qty: u64) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
