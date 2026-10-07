//! `unpause`: stub until M1-04. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct Unpause<'info> {
    /// The admin.
    pub admin: Signer<'info>,
}

pub fn handle_unpause(_ctx: Context<Unpause>) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
