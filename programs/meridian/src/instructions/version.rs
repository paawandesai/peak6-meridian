//! `version`: logs the crate version. Kept until M1-10, when the e2e placeholder that calls it
//! is replaced by the lifecycle smoke.

use anchor_lang::prelude::*;

/// Crate version logged by the `version` instruction.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// `version` reads and writes no accounts.
#[derive(Accounts)]
pub struct Version {}

pub fn handle_version(_ctx: Context<Version>) -> Result<()> {
    msg!("meridian {}", VERSION);
    Ok(())
}
