//! Config migration helpers (M3-10b): turn the stored v2 Config back into the v1 account the
//! devnet program created (the v1 layout is a byte-for-byte prefix of v2) and build
//! `migrate_config`. Included through `common/mod.rs`.

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::types::TransactionResult;
use meridian::state::{PythConfigParams, CONFIG_LEN, CONFIG_V1_LEN};
use solana_sdk::account::Account as SdkAccount;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::system_program;

use super::{config_pda, Harness};

/// Valid Pyth parameters with the given signer and the MAG7 feed ids (D-055), in config order.
pub fn pyth_params(signer: Pubkey) -> PythConfigParams {
    use meridian::pyth::feed_ids;
    PythConfigParams {
        pyth_lazer_signer: signer,
        pyth_feed_ids: [
            feed_ids::AAPL,
            feed_ids::MSFT,
            feed_ids::GOOGL,
            feed_ids::AMZN,
            feed_ids::NVDA,
            feed_ids::META,
            feed_ids::TSLA,
        ],
        pyth_max_age_secs: 30,
    }
}

impl Harness {
    /// The raw Config account.
    pub fn config_account(&self) -> SdkAccount {
        self.svm
            .get_account(&config_pda())
            .expect("config account exists")
    }

    /// Writes `data` at `address` owned by `owner` with `lamports`.
    pub fn put_account(&mut self, address: Pubkey, owner: Pubkey, lamports: u64, data: Vec<u8>) {
        let account = SdkAccount {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(address, account).unwrap();
    }

    /// Rewrites the stored v2 Config as the v1 account the pre-M3-10b program would hold: the
    /// first 1,076 bytes, rent-exempt for that size. Returns the v1 bytes.
    pub fn downgrade_config_to_v1(&mut self) -> Vec<u8> {
        let account = self.config_account();
        assert_eq!(account.data.len(), CONFIG_LEN, "starts from a v2 account");
        let v1 = account.data[..CONFIG_V1_LEN].to_vec();
        let lamports = self.svm.minimum_balance_for_rent_exemption(CONFIG_V1_LEN);
        self.put_account(config_pda(), meridian::ID, lamports, v1.clone());
        v1
    }

    /// `migrate_config` against `config`, signed by `admin`.
    pub fn migrate_config_ix(
        admin: Pubkey,
        config: Pubkey,
        pyth: Option<PythConfigParams>,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::MigrateConfig {
                config,
                admin,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::MigrateConfig { pyth }.data(),
        }
    }

    /// Sends `migrate_config` against the config PDA signed by `signer`.
    pub fn migrate_config_as(
        &mut self,
        signer: &Keypair,
        pyth: Option<PythConfigParams>,
    ) -> TransactionResult {
        let ix = Self::migrate_config_ix(signer.pubkey(), config_pda(), pyth);
        self.send(ix, &[signer])
    }

    /// Sends `migrate_config` as the harness admin.
    pub fn migrate_config(&mut self, pyth: Option<PythConfigParams>) -> TransactionResult {
        let admin = self.admin.insecure_clone();
        self.migrate_config_as(&admin, pyth)
    }
}
