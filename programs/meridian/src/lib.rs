//! Meridian on-chain program.
//!
//! M1-01 placeholder: the only instruction is `version`. State, errors, events and the real
//! instructions arrive with M1-02.

use anchor_lang::prelude::*;

declare_id!("3RovidBTwYzUfhniunxsUgnLzsbWz6qt3PGpvD23HDZq");

/// Crate version logged by the `version` instruction.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[program]
pub mod meridian {
    use super::*;

    /// Logs the crate version. Kept until M1-10: the e2e placeholder calls it.
    pub fn version(_ctx: Context<Version>) -> Result<()> {
        msg!("meridian {}", VERSION);
        Ok(())
    }
}

/// `version` reads and writes no accounts.
#[derive(Accounts)]
pub struct Version {}
