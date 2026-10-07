//! `pause`: stub until M1-04. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct Pause<'info> {
    /// The admin.
    pub admin: Signer<'info>,
}

pub fn handle_pause(_ctx: Context<Pause>) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
