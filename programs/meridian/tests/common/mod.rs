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

pub mod orders;
pub mod redstone;

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
        pyth_lazer_signer: Pubkey::default(),
        pyth_feed_ids: [0; 7], // No Pyth feeds configured by default
        pyth_max_age_secs: 30, // Same default as max_staleness_slots (~12s converted to seconds)
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
    /// the packet size a real cluster does, so this panics on an oversized transaction. The
    /// blockhash is rotated first so an identical instruction can be sent twice in a row.
    pub fn send(&mut self, instruction: Instruction, signers: &[&Keypair]) -> TransactionResult {
        self.svm.expire_blockhash();
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

/// Asserts that the transaction failed with the given `MeridianError` when using `send_with_budget`.
/// The error is at index 1 because ComputeBudget instruction is at index 0.
pub fn assert_meridian_error_with_budget(result: &TransactionResult, expected: MeridianError) {
    let failure = expect_failure(result);
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(1, InstructionError::Custom(error_code(expected))),
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

// ---- M1-04: markets, tokens and the clock ---------------------------------------------------

use anchor_lang::solana_program::clock::Clock;
use meridian::state::{
    Book, Market, BOOK_SEED, ESCROW_USDC_SEED, ESCROW_YES_SEED, MARKET_SEED, NO_MINT_SEED,
    PAIR_COLLATERAL, VAULT_SEED, YES_MINT_SEED,
};
use solana_sdk::account::Account as SdkAccount;

// The ET instants below were computed with a real `America/New_York` conversion
// (Python zoneinfo), not by adding fixed offsets; update them the same way.
/// 2026-10-06 09:00 ET (13:00 UTC, a Tuesday): a plausible "now" for tests.
pub const BASE_UNIX_TS: i64 = 1_791_291_600;
/// 2026-10-06 16:00 ET (20:00 UTC): the normal close of [`BASE_TRADING_DATE`].
pub const BASE_CLOSE_TS: i64 = 1_791_316_800;
/// 2026-11-27 13:00 ET (18:00 UTC): the early close of the day after Thanksgiving.
pub const EARLY_CLOSE_TS: i64 = 1_795_802_400;
/// The trading date matching [`BASE_CLOSE_TS`].
pub const BASE_TRADING_DATE: u32 = 20_261_006;
/// META $680.
pub const BASE_STRIKE_CENTS: u64 = 68_000;

/// Arguments of one market creation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketArgs {
    pub ticker: [u8; SYMBOL_LEN],
    pub strike_cents: u64,
    pub trading_date: u32,
    pub close_ts: i64,
}

impl MarketArgs {
    /// META $680 on 2026-10-06, closing at 16:00 ET.
    pub fn base() -> Self {
        MarketArgs {
            ticker: symbol("META"),
            strike_cents: BASE_STRIKE_CENTS,
            trading_date: BASE_TRADING_DATE,
            close_ts: BASE_CLOSE_TS,
        }
    }

    /// The same market with another strike.
    pub fn with_strike(self, strike_cents: u64) -> Self {
        MarketArgs {
            strike_cents,
            ..self
        }
    }
}

/// Every PDA of one market (architecture.md § Data model).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketAddresses {
    pub market: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub escrow_usdc: Pubkey,
    pub escrow_yes: Pubkey,
    pub book: Pubkey,
}

impl MarketAddresses {
    pub fn derive(args: &MarketArgs) -> Self {
        let market = Pubkey::find_program_address(
            &[
                MARKET_SEED,
                &args.ticker,
                &args.trading_date.to_le_bytes(),
                &args.strike_cents.to_le_bytes(),
            ],
            &meridian::ID,
        )
        .0;
        let child =
            |seed: &[u8]| Pubkey::find_program_address(&[seed, market.as_ref()], &meridian::ID).0;
        MarketAddresses {
            market,
            yes_mint: child(YES_MINT_SEED),
            no_mint: child(NO_MINT_SEED),
            vault: child(VAULT_SEED),
            escrow_usdc: child(ESCROW_USDC_SEED),
            escrow_yes: child(ESCROW_YES_SEED),
            book: child(BOOK_SEED),
        }
    }
}

/// A user with a keypair and token accounts for one market.
pub struct User {
    pub keypair: Keypair,
    pub usdc: Pubkey,
    pub yes: Pubkey,
    pub no: Pubkey,
}

impl User {
    pub fn pubkey(&self) -> Pubkey {
        self.keypair.pubkey()
    }
}

impl Harness {
    /// The current `Clock` sysvar.
    pub fn clock(&self) -> Clock {
        self.svm.get_sysvar::<Clock>()
    }

    /// Sets `Clock::unix_timestamp` (the slot is left alone).
    pub fn set_unix_timestamp(&mut self, unix_timestamp: i64) {
        let mut clock = self.clock();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    /// Writes an initialised SPL token account for `mint` owned by `owner` holding `amount`.
    pub fn create_token_account(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
        let address = Pubkey::new_unique();
        self.write_token_account(address, mint, owner, amount);
        address
    }

    /// Writes (or overwrites) the token account at `address`.
    pub fn write_token_account(
        &mut self,
        address: Pubkey,
        mint: Pubkey,
        owner: Pubkey,
        amount: u64,
    ) {
        let token_account = spl_token::state::Account {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: spl_token::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        token_account.pack_into_slice(&mut data);
        let account = SdkAccount {
            lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(address, account).unwrap();
    }

    /// The balance of a token account.
    pub fn token_amount(&self, address: Pubkey) -> u64 {
        self.token_account(address).amount
    }

    /// The unpacked token account.
    pub fn token_account(&self, address: Pubkey) -> spl_token::state::Account {
        let account = self
            .svm
            .get_account(&address)
            .expect("token account exists");
        assert_eq!(account.owner, spl_token::ID, "owned by the token program");
        spl_token::state::Account::unpack(&account.data).expect("token account unpacks")
    }

    /// The unpacked mint.
    pub fn mint(&self, address: Pubkey) -> spl_token::state::Mint {
        let account = self.svm.get_account(&address).expect("mint exists");
        assert_eq!(account.owner, spl_token::ID, "owned by the token program");
        spl_token::state::Mint::unpack(&account.data).expect("mint unpacks")
    }

    /// The supply of a mint.
    pub fn mint_supply(&self, address: Pubkey) -> u64 {
        self.mint(address).supply
    }

    /// The stored market.
    pub fn market(&self, address: Pubkey) -> Market {
        let account = self.svm.get_account(&address).expect("market exists");
        assert_eq!(
            account.owner,
            meridian::ID,
            "market is owned by the program"
        );
        Market::try_deserialize(&mut account.data.as_slice()).expect("market deserialises")
    }

    /// True when no account exists at `address`.
    pub fn is_absent(&self, address: Pubkey) -> bool {
        self.svm.get_account(&address).is_none()
    }

    /// The stored book (zero-copy).
    pub fn book(&self, address: Pubkey) -> Book {
        let account = self.svm.get_account(&address).expect("book exists");
        assert_eq!(account.owner, meridian::ID, "book is owned by the program");
        assert_eq!(account.data.len(), Book::SPACE);
        assert_eq!(&account.data[..8], Book::DISCRIMINATOR);
        *bytemuck::from_bytes::<Book>(&account.data[8..])
    }

    /// A funded user with USDC, YES and NO accounts for `market`, holding `usdc` base units.
    pub fn user_for(&mut self, market: &MarketAddresses, usdc: u64) -> User {
        let keypair = self.funded_keypair();
        let owner = keypair.pubkey();
        let usdc_mint = self.usdc_mint;
        User {
            usdc: self.create_token_account(usdc_mint, owner, usdc),
            yes: self.create_token_account(market.yes_mint, owner, 0),
            no: self.create_token_account(market.no_mint, owner, 0),
            keypair,
        }
    }

    /// `create_strike_market` signed by `signer` against `config`, for `args`.
    pub fn create_strike_market_ix(
        signer: Pubkey,
        config: Pubkey,
        usdc_mint: Pubkey,
        addresses: &MarketAddresses,
        args: &MarketArgs,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::CreateStrikeMarket {
                config,
                automation_authority: signer,
                market: addresses.market,
                yes_mint: addresses.yes_mint,
                no_mint: addresses.no_mint,
                vault: addresses.vault,
                escrow_usdc: addresses.escrow_usdc,
                escrow_yes: addresses.escrow_yes,
                book: addresses.book,
                usdc_mint,
                token_program: spl_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::CreateStrikeMarket {
                ticker: args.ticker,
                strike_cents: args.strike_cents,
                trading_date: args.trading_date,
                close_ts: args.close_ts,
            }
            .data(),
        }
    }

    /// `add_strike` signed by `signer` against `config`, for `args`.
    pub fn add_strike_ix(
        signer: Pubkey,
        config: Pubkey,
        usdc_mint: Pubkey,
        addresses: &MarketAddresses,
        args: &MarketArgs,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::AddStrike {
                config,
                admin: signer,
                market: addresses.market,
                yes_mint: addresses.yes_mint,
                no_mint: addresses.no_mint,
                vault: addresses.vault,
                escrow_usdc: addresses.escrow_usdc,
                escrow_yes: addresses.escrow_yes,
                book: addresses.book,
                usdc_mint,
                token_program: spl_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::AddStrike {
                ticker: args.ticker,
                strike_cents: args.strike_cents,
                trading_date: args.trading_date,
                close_ts: args.close_ts,
            }
            .data(),
        }
    }

    /// Sends `create_strike_market` signed by `signer` with the harness config and mint.
    pub fn create_strike_market_as(
        &mut self,
        signer: &Keypair,
        args: &MarketArgs,
    ) -> (MarketAddresses, TransactionResult) {
        let addresses = MarketAddresses::derive(args);
        let ix = Self::create_strike_market_ix(
            signer.pubkey(),
            config_pda(),
            self.usdc_mint,
            &addresses,
            args,
        );
        let result = self.send(ix, &[signer]);
        (addresses, result)
    }

    /// Sends `add_strike` signed by `signer` with the harness config and mint.
    pub fn add_strike_as(
        &mut self,
        signer: &Keypair,
        args: &MarketArgs,
    ) -> (MarketAddresses, TransactionResult) {
        let addresses = MarketAddresses::derive(args);
        let ix = Self::add_strike_ix(
            signer.pubkey(),
            config_pda(),
            self.usdc_mint,
            &addresses,
            args,
        );
        let result = self.send(ix, &[signer]);
        (addresses, result)
    }

    /// `mint_pair` for `user` on `addresses`.
    pub fn mint_pair_ix(user: &User, addresses: &MarketAddresses, qty: u64) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::MintPair {
                config: config_pda(),
                market: addresses.market,
                user: user.pubkey(),
                user_usdc: user.usdc,
                user_yes: user.yes,
                user_no: user.no,
                yes_mint: addresses.yes_mint,
                no_mint: addresses.no_mint,
                vault: addresses.vault,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::MintPair { qty }.data(),
        }
    }

    /// Sends `mint_pair` for `user`.
    pub fn mint_pair(
        &mut self,
        user: &User,
        addresses: &MarketAddresses,
        qty: u64,
    ) -> TransactionResult {
        self.send(Self::mint_pair_ix(user, addresses, qty), &[&user.keypair])
    }

    /// `redeem` for `user` on `addresses`.
    pub fn redeem_ix(
        user: &User,
        addresses: &MarketAddresses,
        yes_qty: u64,
        no_qty: u64,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::Redeem {
                market: addresses.market,
                user: user.pubkey(),
                user_usdc: user.usdc,
                user_yes: user.yes,
                user_no: user.no,
                yes_mint: addresses.yes_mint,
                no_mint: addresses.no_mint,
                vault: addresses.vault,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::Redeem { yes_qty, no_qty }.data(),
        }
    }

    /// Sends `redeem` for `user`.
    pub fn redeem(
        &mut self,
        user: &User,
        addresses: &MarketAddresses,
        yes_qty: u64,
        no_qty: u64,
    ) -> TransactionResult {
        self.send(
            Self::redeem_ix(user, addresses, yes_qty, no_qty),
            &[&user.keypair],
        )
    }

    /// Sends `pause` signed by `signer` against the config PDA.
    pub fn pause_as(&mut self, signer: &Keypair) -> TransactionResult {
        let ix = Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::Pause {
                config: config_pda(),
                admin: signer.pubkey(),
            }
            .to_account_metas(None),
            data: meridian::instruction::Pause {}.data(),
        };
        self.send(ix, &[signer])
    }

    /// Sends `unpause` signed by `signer` against the config PDA.
    pub fn unpause_as(&mut self, signer: &Keypair) -> TransactionResult {
        let ix = Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::Unpause {
                config: config_pda(),
                admin: signer.pubkey(),
            }
            .to_account_metas(None),
            data: meridian::instruction::Unpause {}.data(),
        };
        self.send(ix, &[signer])
    }

    /// Sends `pause` as the harness admin.
    pub fn pause(&mut self) -> TransactionResult {
        let admin = self.admin.insecure_clone();
        self.pause_as(&admin)
    }

    /// Sends `unpause` as the harness admin.
    pub fn unpause(&mut self) -> TransactionResult {
        let admin = self.admin.insecure_clone();
        self.unpause_as(&admin)
    }

    /// Asserts invariants 1 and 3 (domain.md): vault = 1,000,000 × pairs outstanding and
    /// YES supply = NO supply = pairs outstanding (before settlement).
    pub fn assert_market_invariants(&self, addresses: &MarketAddresses) {
        let market = self.market(addresses.market);
        let pairs = market.pairs_outstanding;
        assert_eq!(
            self.token_amount(addresses.vault),
            pairs.checked_mul(PAIR_COLLATERAL).expect("fits"),
            "vault = 1,000,000 × pairs outstanding"
        );
        assert_eq!(self.mint_supply(addresses.yes_mint), pairs, "YES supply");
        assert_eq!(self.mint_supply(addresses.no_mint), pairs, "NO supply");
    }
}

/// A harness with the config initialised (all seven tickers), the clock at [`BASE_UNIX_TS`]
/// and a funded automation authority.
pub struct MarketHarness {
    pub harness: Harness,
    pub automation: Keypair,
}

impl Default for MarketHarness {
    fn default() -> Self {
        Self::new()
    }
}

impl MarketHarness {
    pub fn new() -> Self {
        let mut harness = Harness::new();
        harness.set_unix_timestamp(BASE_UNIX_TS);
        let automation = harness.funded_keypair();
        expect_success(&harness.initialize_config(&default_params(automation.pubkey())));
        let mut rest = default_params(automation.pubkey());
        rest.tickers = mag7_slots(6..7);
        expect_success(&harness.update_config(&rest));
        MarketHarness {
            harness,
            automation,
        }
    }

    /// Creates a market as the automation authority and asserts success.
    pub fn create_market(&mut self, args: &MarketArgs) -> MarketAddresses {
        let (addresses, result) = self.harness.create_strike_market_as(&self.automation, args);
        expect_success(&result);
        addresses
    }

    /// The base market (META $680), created.
    pub fn base_market(&mut self) -> MarketAddresses {
        self.create_market(&MarketArgs::base())
    }
}

/// Asserts that the transaction failed inside the SPL token program with `expected`.
pub fn assert_token_error(result: &TransactionResult, expected: spl_token::error::TokenError) {
    let failure = expect_failure(result);
    let code = expected.clone() as u32;
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(code)),
        "expected token error {expected:?}; logs: {:#?}",
        failure.meta.logs
    );
}

// ---- M1-07: settlement ------------------------------------------------------------------------

pub mod settlement;

// ---- M3-10b: Config migration and the Pyth settlement path -----------------------------------

pub mod migration;
pub mod pyth;
