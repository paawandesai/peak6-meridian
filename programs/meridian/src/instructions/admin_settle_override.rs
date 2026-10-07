//! `admin_settle_override`: stub until M1-07. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct AdminSettleOverride<'info> {
    /// The admin.
    pub admin: Signer<'info>,
}

pub fn handle_admin_settle_override(
    _ctx: Context<AdminSettleOverride>,
    _settle_price_cents: u64,
) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
