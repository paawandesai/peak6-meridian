//! `local_oracle_set`: test-only oracle writer behind the `local-oracle` feature (D-028, AB-22).
//! Stub until M1-07. Returns `MeridianError::NotImplemented`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::SYMBOL_LEN;
#[derive(Accounts)]
pub struct LocalOracleSet<'info> {
    /// The local oracle writer (test only).
    pub authority: Signer<'info>,
}

pub fn handle_local_oracle_set(
    _ctx: Context<LocalOracleSet>,
    _ticker: [u8; SYMBOL_LEN],
    _source_slot: u8,
    _value: i128,
    _slot: u64,
) -> Result<()> {
    Err(MeridianError::NotImplemented.into())
}
