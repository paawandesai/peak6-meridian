//! LiteSVM harness shared by the program tests and the abuse-case tests in
//! `tests/security/program` (which includes this file by path). Runs the program built by
//! `make build-local` (`target/deploy/meridian.so`), so build before testing.

// Test helpers: the program rules on unwrap/panic/arithmetic do not apply here.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects,
    clippy::result_large_err
)]

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, Discriminator, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use base64::prelude::{Engine, BASE64_STANDARD};
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata, TransactionResult};
use litesvm::LiteSVM;
use meridian::errors::MeridianError;
use meridian::state::{Config, ConfigParams, Ticker, TickerSlot, SYMBOL_LEN, TICKER_COUNT};
use solana_sdk::instruction::{Instruction, InstructionError};
use solana_sdk::packet::PACKET_DATA_SIZE;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::system_program;
use solana_sdk::transaction::{Transaction, TransactionError};

/// Lamports airdropped to every test signer.
pub const FUNDING_LAMPORTS: u64 = 10_000_000_000;

/// The MAG7 symbols (domain.md § Glossary), in config order.
pub const MAG7: [&str; TICKER_COUNT] = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

/// The repository root: the nearest ancestor of this file holding `Anchor.toml`.
pub fn repo_root() -> PathBuf {
    let here = PathBuf::from(file!());
    let start = if here.is_absolute() {
        here
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(here)
    };
    start
        .ancestors()
        .find(|dir| dir.join("Anchor.toml").is_file())
        .map(PathBuf::from)
        .expect("Anchor.toml above the test harness")
}

/// Path of the program built by `make build-local`.
pub fn program_path() -> PathBuf {
    repo_root().join("target/deploy/meridian.so")
}

/// Zero-padded symbol bytes, e.g. `symbol("META") == *b"META\0\0\0\0"`.
pub fn symbol(text: &str) -> [u8; SYMBOL_LEN] {
    let mut out = [0u8; SYMBOL_LEN];
    out[..text.len()].copy_from_slice(text.as_bytes());
    out
}

/// A ticker with distinct, deterministic feeds and hashes derived from `index`.
pub fn ticker(text: &str, index: u8) -> Ticker {
    Ticker {
        symbol: symbol(text),
        feeds: [Pubkey::new_unique(), Pubkey::new_unique()],
        feed_hashes: [[index; 32], [index.wrapping_add(100); 32]],
    }
}

/// The MAG7 ticker slots `indexes`, with deterministic feeds and hashes.
pub fn mag7_slots(indexes: impl IntoIterator<Item = usize>) -> Vec<TickerSlot> {
    indexes
        .into_iter()
        .map(|index| TickerSlot {
            index: index as u8,
            ticker: ticker(MAG7[index], index as u8 + 1),
        })
        .collect()
}

/// Valid parameters with the domain defaults and the first six MAG7 tickers (the most one
/// transaction carries); `mag7_slots(6..7)` completes the set with `update_config`.
pub fn default_params(automation_authority: Pubkey) -> ConfigParams {
    ConfigParams {
        automation_authority,
        max_staleness_slots: 30,
        max_conf_bps: 5,
        override_delay_secs: 3_600,
        tickers: mag7_slots(0..6),
    }
}

/// The ticker array that `params` produces over `current` (empty by default).
pub fn expected_tickers(
    params: &ConfigParams,
    current: Option<[Ticker; TICKER_COUNT]>,
) -> [Ticker; TICKER_COUNT] {
    let mut tickers = current.unwrap_or([Ticker::default(); TICKER_COUNT]);
    for slot in &params.tickers {
        tickers[usize::from(slot.index)] = slot.ticker;
    }
    tickers
}

/// Serialized size of a signed transaction, as counted against `PACKET_DATA_SIZE`.
pub fn transaction_size(tx: &Transaction) -> usize {
    1 + 64 * tx.signatures.len() + tx.message.serialize().len()
}

/// The config PDA: seeds `["config"]`.
pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[meridian::state::CONFIG_SEED], &meridian::ID).0
}

/// A LiteSVM instance with the program loaded, a funded admin and a 6-decimal test-USDC mint.
pub struct Harness {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub usdc_mint: Pubkey,
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

impl Harness {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let path = program_path();
        svm.add_program_from_file(meridian::ID, &path)
            .unwrap_or_else(|error| {
                panic!(
                    "cannot load {}: {error}; run make build-local",
                    path.display()
                )
            });
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), FUNDING_LAMPORTS).unwrap();
        let mut harness = Harness {
            svm,
            admin,
            usdc_mint: Pubkey::default(),
        };
        harness.usdc_mint = harness.create_mint(6);
        harness
    }

    /// A new funded keypair.
    pub fn funded_keypair(&mut self) -> Keypair {
        let keypair = Keypair::new();
        self.svm
            .airdrop(&keypair.pubkey(), FUNDING_LAMPORTS)
            .unwrap();
        keypair
    }

    /// Writes an initialised SPL mint with the given decimals (authority: the admin).
    pub fn create_mint(&mut self, decimals: u8) -> Pubkey {
        let mint = spl_token::state::Mint {
            mint_authority: COption::Some(self.admin.pubkey()),
            supply: 0,
            decimals,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        mint.pack_into_slice(&mut data);
        let address = Pubkey::new_unique();
        let account = solana_sdk::account::Account {
            lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(address, account).unwrap();
        address
    }

    /// Signs one instruction with `signers` (the first one pays).
    pub fn transaction(&self, instruction: Instruction, signers: &[&Keypair]) -> Transaction {
        let payer = signers.first().expect("at least one signer").pubkey();
        Transaction::new_signed_with_payer(
            &[instruction],
            Some(&payer),
            signers,
            self.svm.latest_blockhash(),
        )
    }

    /// Sends one instruction signed by `signers` (the first one pays). LiteSVM does not enforce
    /// the packet size a real cluster does, so this panics on an oversized transaction.
    pub fn send(&mut self, instruction: Instruction, signers: &[&Keypair]) -> TransactionResult {
        let tx = self.transaction(instruction, signers);
        let size = transaction_size(&tx);
        assert!(
            size <= PACKET_DATA_SIZE,
            "transaction is {size} bytes, above the {PACKET_DATA_SIZE}-byte packet limit"
        );
        self.svm.send_transaction(tx)
    }

    /// The `initialize_config` instruction for `admin` with the given mint.
    pub fn initialize_config_ix(
        admin: &Keypair,
        usdc_mint: Pubkey,
        params: &ConfigParams,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::InitializeConfig {
                config: config_pda(),
                admin: admin.pubkey(),
                usdc_mint,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::InitializeConfig {
                params: params.clone(),
            }
            .data(),
        }
    }

    /// Sends `initialize_config` signed by `admin` with the given mint.
    pub fn initialize_config_as(
        &mut self,
        admin: &Keypair,
        usdc_mint: Pubkey,
        params: &ConfigParams,
    ) -> TransactionResult {
        self.send(
            Self::initialize_config_ix(admin, usdc_mint, params),
            &[admin],
        )
    }

    /// Sends `initialize_config` as the harness admin with the test-USDC mint.
    pub fn initialize_config(&mut self, params: &ConfigParams) -> TransactionResult {
        let admin = self.admin.insecure_clone();
        let usdc_mint = self.usdc_mint;
        self.initialize_config_as(&admin, usdc_mint, params)
    }

    /// Sends `update_config` signed by `signer`, with the given config account and mint.
    pub fn update_config_as(
        &mut self,
        signer: &Keypair,
        config: Pubkey,
        usdc_mint: Pubkey,
        params: &ConfigParams,
    ) -> TransactionResult {
        let instruction = Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::UpdateConfig {
                config,
                admin: signer.pubkey(),
                usdc_mint,
            }
            .to_account_metas(None),
            data: meridian::instruction::UpdateConfig {
                params: params.clone(),
            }
            .data(),
        };
        self.send(instruction, &[signer])
    }

    /// Sends `update_config` as the harness admin with the test-USDC mint.
    pub fn update_config(&mut self, params: &ConfigParams) -> TransactionResult {
        let admin = self.admin.insecure_clone();
        let usdc_mint = self.usdc_mint;
        self.update_config_as(&admin, config_pda(), usdc_mint, params)
    }

    /// The stored config.
    pub fn config(&self) -> Config {
        let account = self
            .svm
            .get_account(&config_pda())
            .expect("config account exists");
        assert_eq!(
            account.owner,
            meridian::ID,
            "config is owned by the program"
        );
        Config::try_deserialize(&mut account.data.as_slice()).expect("config deserialises")
    }

    /// True when the config account does not exist.
    pub fn config_is_absent(&self) -> bool {
        self.svm.get_account(&config_pda()).is_none()
    }
}

/// The program's error code for a `MeridianError` variant, as it appears in transaction errors.
pub fn error_code(error: MeridianError) -> u32 {
    u32::from(error)
}

/// Asserts that the transaction failed with the given `MeridianError`.
pub fn assert_meridian_error(result: &TransactionResult, expected: MeridianError) {
    let failure = expect_failure(result);
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(error_code(expected))),
        "expected {expected:?}; logs: {:#?}",
        failure.meta.logs
    );
}

/// Asserts that the transaction failed with the given Anchor framework error code.
pub fn assert_anchor_error(result: &TransactionResult, expected: anchor_lang::error::ErrorCode) {
    let failure = expect_failure(result);
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(expected as u32)),
        "expected {expected:?}; logs: {:#?}",
        failure.meta.logs
    );
}

/// The failure of a transaction that must not have succeeded.
pub fn expect_failure(result: &TransactionResult) -> &FailedTransactionMetadata {
    match result {
        Ok(meta) => panic!("transaction succeeded unexpectedly; logs: {:#?}", meta.logs),
        Err(failure) => failure,
    }
}

/// The metadata of a transaction that must have succeeded.
pub fn expect_success(result: &TransactionResult) -> &TransactionMetadata {
    match result {
        Ok(meta) => meta,
        Err(failure) => panic!(
            "transaction failed: {:?}; logs: {:#?}",
            failure.err, failure.meta.logs
        ),
    }
}

/// Decodes the first event of type `E` emitted in the transaction logs, if any.
pub fn find_event<E: anchor_lang::Event + Discriminator>(meta: &TransactionMetadata) -> Option<E> {
    meta.logs
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|payload| BASE64_STANDARD.decode(payload).ok())
        .filter(|bytes| bytes.starts_with(E::DISCRIMINATOR))
        .find_map(|bytes| E::try_from_slice(&bytes[E::DISCRIMINATOR.len()..]).ok())
}
