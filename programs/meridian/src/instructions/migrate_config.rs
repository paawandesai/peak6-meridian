//! `migrate_config` (M3-10b): the admin grows the v1 Config account (1,076 bytes, created
//! before the Pyth fields existed) to the current layout (1,144 bytes) in place.
//!
//! The Pyth fields were appended after `bump`, so the v1 bytes are a prefix of the v2 layout and
//! stay byte-for-byte unchanged. The handler reads the v1 prefix by hand (a v1 account cannot
//! deserialize as the v2 `Config`), checks discriminator, size, bump and admin, tops up rent
//! from the admin, reallocs, zero-fills the new bytes and optionally writes the Pyth fields.
//!
//! Between a program upgrade and this call every instruction that loads `Config` fails with
//! Anchor's `AccountDidNotDeserialize` (no panic); `cancel_order`, `settle_funds`, `redeem` and
//! `post_redstone_price` never load `Config` and keep working. A second call fails with
//! `ConfigAlreadyMigrated` and changes nothing.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_lang::Discriminator;

use crate::errors::MeridianError;
use crate::events::ConfigMigrated;
use crate::state::{
    Config, PythConfigParams, CONFIG_ADMIN_OFFSET, CONFIG_BUMP_OFFSET, CONFIG_LEN,
    CONFIG_PYTH_FIELDS_LEN, CONFIG_SEED, CONFIG_V1_LEN,
};

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    /// The Config PDA, owned by this program. Discriminator, size, bump and admin are checked in
    /// the handler by reading the v1 prefix (a v1 account cannot deserialize as `Config`).
    /// CHECK: owner and seeds are constrained here; the layout is verified in the handler.
    #[account(mut, seeds = [CONFIG_SEED], bump, owner = crate::ID)]
    pub config: UncheckedAccount<'info>,
    /// Must equal the admin stored in the Config; pays the rent top-up.
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Checks the stored prefix (discriminator, length, canonical bump, admin), then that the
/// account still has the v1 size: `ConfigAlreadyMigrated` at the current size, otherwise
/// `ConfigLayoutMismatch`.
fn check_prefix(data: &[u8], bump: u8, admin: &Pubkey) -> Result<()> {
    require!(
        data.get(..8) == Some(Config::DISCRIMINATOR),
        MeridianError::ConfigLayoutMismatch
    );
    require!(
        data.len() >= CONFIG_V1_LEN,
        MeridianError::ConfigLayoutMismatch
    );
    require!(
        data.get(CONFIG_BUMP_OFFSET) == Some(&bump),
        MeridianError::ConfigLayoutMismatch
    );
    let admin_end = CONFIG_ADMIN_OFFSET
        .checked_add(32)
        .ok_or(MeridianError::MathOverflow)?;
    let stored_admin = data
        .get(CONFIG_ADMIN_OFFSET..admin_end)
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .map(Pubkey::new_from_array)
        .ok_or(MeridianError::ConfigLayoutMismatch)?;
    require_keys_eq!(stored_admin, *admin, MeridianError::AdminOnly);
    require!(
        data.len() != CONFIG_LEN,
        MeridianError::ConfigAlreadyMigrated
    );
    require!(
        data.len() == CONFIG_V1_LEN,
        MeridianError::ConfigLayoutMismatch
    );
    Ok(())
}

/// The 68 bytes appended after `bump`: zeros, or the Pyth fields in `Config` field order.
fn pyth_tail(pyth: Option<&PythConfigParams>) -> Result<[u8; CONFIG_PYTH_FIELDS_LEN]> {
    let mut tail = [0u8; CONFIG_PYTH_FIELDS_LEN];
    if let Some(params) = pyth {
        require!(
            params.pyth_max_age_secs > 0,
            MeridianError::InvalidPythMaxAge
        );
        let bytes = params.try_to_vec()?;
        require!(
            bytes.len() == CONFIG_PYTH_FIELDS_LEN,
            MeridianError::ConfigLayoutMismatch
        );
        tail.copy_from_slice(&bytes);
    }
    Ok(tail)
}

pub fn handle_migrate_config(
    ctx: Context<MigrateConfig>,
    pyth: Option<PythConfigParams>,
) -> Result<()> {
    let config = ctx.accounts.config.to_account_info();
    let admin = ctx.accounts.admin.key();
    let old_len = config.data_len();
    check_prefix(&config.try_borrow_data()?, ctx.bumps.config, &admin)?;
    let tail = pyth_tail(pyth.as_ref())?;

    // Rent for the grown account, paid by the admin before the realloc.
    let required = Rent::get()?.minimum_balance(CONFIG_LEN);
    let rent_top_up = required.saturating_sub(config.lamports());
    if rent_top_up > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: config.clone(),
                },
            ),
            rent_top_up,
        )?;
    }

    config.realloc(CONFIG_LEN, true)?;
    let migrated = {
        let mut data = config.try_borrow_mut_data()?;
        data.get_mut(CONFIG_V1_LEN..CONFIG_LEN)
            .ok_or(MeridianError::ConfigLayoutMismatch)?
            .copy_from_slice(&tail);
        // The grown account must now decode as the current `Config`, with the same admin/bump.
        Config::try_deserialize(&mut &data[..])?
    };
    require_keys_eq!(migrated.admin, admin, MeridianError::ConfigLayoutMismatch);
    require!(
        migrated.bump == ctx.bumps.config,
        MeridianError::ConfigLayoutMismatch
    );

    emit!(ConfigMigrated {
        admin,
        old_len: u32::try_from(old_len).map_err(|_| MeridianError::MathOverflow)?,
        new_len: u32::try_from(CONFIG_LEN).map_err(|_| MeridianError::MathOverflow)?,
        rent_top_up,
        pyth_set: pyth.is_some(),
        pyth_lazer_signer: migrated.pyth_lazer_signer,
        pyth_max_age_secs: migrated.pyth_max_age_secs,
    });
    Ok(())
}
