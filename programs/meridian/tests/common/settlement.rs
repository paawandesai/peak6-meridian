//! Settlement helpers (M1-07): Switchboard feed accounts written straight into LiteSVM, the
//! `settle_market` / `admin_settle_override` instructions, and a harness with a settled-ready
//! META market. Included through `common/mod.rs`.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::clock::Clock;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::{AnchorSerialize, InstructionData, ToAccountMetas};
use litesvm::types::TransactionResult;
use meridian::oracle::{PULL_FEED_DISCRIMINATOR, PULL_FEED_LEN, SWITCHBOARD_DEVNET_PID};
use meridian::state::{STRIKE_CENTS_TO_SCALED, SYMBOL_LEN};
use solana_sdk::account::Account as SdkAccount;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::system_program;

use super::{
    config_pda, expect_success, symbol, Harness, MarketAddresses, MarketArgs, MarketHarness,
    BASE_CLOSE_TS,
};

/// Slot the settlement harness starts at.
pub const START_SLOT: u64 = 1_000;
/// Seconds after close at which feeds are published and settlement is tried.
pub const SETTLE_DELAY_SECS: i64 = 300;

/// Byte offsets inside a `PullFeedAccountData` account (see `meridian::oracle`).
const FEED_HASH_OFFSET: usize = 8 + 2_112;
pub const LAST_UPDATE_TS_OFFSET: usize = 8 + 2_208;
const RESULT_VALUE_OFFSET: usize = 8 + 2_256;
const RESULT_SLOT_OFFSET: usize = 8 + 2_360;

/// `PullFeedAccountData` bytes with the fields settlement reads; everything else is zero.
pub fn pull_feed_data(feed_hash: [u8; 32], value: i128, slot: u64, updated_at: i64) -> Vec<u8> {
    let mut data = vec![0u8; PULL_FEED_LEN];
    data[..8].copy_from_slice(&PULL_FEED_DISCRIMINATOR);
    data[FEED_HASH_OFFSET..FEED_HASH_OFFSET + 32].copy_from_slice(&feed_hash);
    data[LAST_UPDATE_TS_OFFSET..LAST_UPDATE_TS_OFFSET + 8]
        .copy_from_slice(&updated_at.to_le_bytes());
    data[RESULT_VALUE_OFFSET..RESULT_VALUE_OFFSET + 16].copy_from_slice(&value.to_le_bytes());
    data[RESULT_SLOT_OFFSET..RESULT_SLOT_OFFSET + 8].copy_from_slice(&slot.to_le_bytes());
    data
}

/// A price in dollars and cents as an 18-digit oracle value.
pub fn scaled_cents(cents: u64) -> i128 {
    i128::from(cents) * STRIKE_CENTS_TO_SCALED
}

/// The local oracle feed PDA: seeds `["local_feed", ticker, [source_slot]]`.
pub fn local_feed_pda(ticker: &[u8; SYMBOL_LEN], source_slot: u8) -> Pubkey {
    Pubkey::find_program_address(&[b"local_feed", ticker, &[source_slot]], &meridian::ID).0
}

impl Harness {
    /// Sets `Clock::slot` (the timestamp is left alone).
    pub fn set_slot(&mut self, slot: u64) {
        let mut clock: Clock = self.clock();
        clock.slot = slot;
        self.svm.set_sysvar(&clock);
    }

    /// Writes a feed account at `address` owned by `owner`.
    pub fn set_feed_account(&mut self, address: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let account = SdkAccount {
            lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(address, account).unwrap();
    }

    /// `settle_market` with explicit feed accounts.
    pub fn settle_market_ix(
        payer: Pubkey,
        addresses: &MarketAddresses,
        feed_tiingo: Pubkey,
        feed_twelve_data: Pubkey,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::SettleMarket {
                config: config_pda(),
                market: addresses.market,
                feed_tiingo,
                feed_twelve_data,
                payer,
            }
            .to_account_metas(None),
            data: meridian::instruction::SettleMarket {}.data(),
        }
    }

    /// `admin_settle_override` signed by `signer`.
    pub fn override_ix(
        signer: Pubkey,
        addresses: &MarketAddresses,
        settle_price_cents: u64,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::AdminSettleOverride {
                config: config_pda(),
                market: addresses.market,
                admin: signer,
            }
            .to_account_metas(None),
            data: meridian::instruction::AdminSettleOverride { settle_price_cents }.data(),
        }
    }

    /// `local_oracle_set` (built by hand: the test crates compile the program without the
    /// `local-oracle` feature, but run the `.so` built with it).
    pub fn local_oracle_set_ix(
        admin: Pubkey,
        ticker: [u8; SYMBOL_LEN],
        source_slot: u8,
        value: i128,
        slot: u64,
    ) -> Instruction {
        let mut data = hash(b"global:local_oracle_set").to_bytes()[..8].to_vec();
        (ticker, source_slot, value, slot)
            .serialize(&mut data)
            .unwrap();
        Instruction {
            program_id: meridian::ID,
            accounts: vec![
                AccountMeta::new_readonly(config_pda(), false),
                AccountMeta::new(local_feed_pda(&ticker, source_slot), false),
                AccountMeta::new(admin, true),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data,
        }
    }
}

/// A market harness with the clock at close + 5 minutes and slot [`START_SLOT`], the base META
/// $680 market created, and a funded random payer.
pub struct SettlementHarness {
    pub market_harness: MarketHarness,
    pub addresses: MarketAddresses,
    pub payer: Keypair,
}

impl Default for SettlementHarness {
    fn default() -> Self {
        Self::new()
    }
}

impl SettlementHarness {
    pub fn new() -> Self {
        Self::with_strike(MarketArgs::base().strike_cents)
    }

    pub fn with_strike(strike_cents: u64) -> Self {
        let mut market_harness = MarketHarness::new();
        let addresses = market_harness.create_market(&MarketArgs::base().with_strike(strike_cents));
        let payer = market_harness.harness.funded_keypair();
        let mut this = SettlementHarness {
            market_harness,
            addresses,
            payer,
        };
        this.h()
            .set_unix_timestamp(BASE_CLOSE_TS + SETTLE_DELAY_SECS);
        this.h().set_slot(START_SLOT);
        this
    }

    /// The stored market.
    pub fn market(&mut self) -> meridian::state::Market {
        let address = self.addresses.market;
        self.h().market(address)
    }

    /// A funded user holding `pairs` YES and `pairs` NO. The clock is rewound to before close for
    /// the mint (no minting at or after close) and restored afterwards.
    pub fn holder(&mut self, pairs: u64) -> super::User {
        let addresses = self.addresses;
        let clock: Clock = self.h().clock();
        self.h().set_unix_timestamp(super::BASE_UNIX_TS);
        let user = self
            .h()
            .user_for(&addresses, pairs * super::PAIR_COLLATERAL);
        expect_success(&self.h().mint_pair(&user, &addresses, pairs));
        self.h().set_unix_timestamp(clock.unix_timestamp);
        user
    }

    pub fn h(&mut self) -> &mut Harness {
        &mut self.market_harness.harness
    }

    /// The pinned (account, hash) of `ticker` for `source` (0 = Tiingo, 1 = Twelve Data).
    pub fn pinned(&mut self, ticker: &str, source: usize) -> (Pubkey, [u8; 32]) {
        let config = self.h().config();
        let pinned = config.ticker(&symbol(ticker)).expect("ticker in config");
        (pinned.feeds[source], pinned.feed_hashes[source])
    }

    /// Publishes a Switchboard feed for `ticker`/`source` with the pinned hash and a fresh,
    /// after-close update at the current clock.
    pub fn publish(&mut self, ticker: &str, source: usize, value: i128) {
        let clock = self.h().clock();
        let (key, hash) = self.pinned(ticker, source);
        let data = pull_feed_data(hash, value, clock.slot, clock.unix_timestamp);
        self.h().set_feed_account(key, SWITCHBOARD_DEVNET_PID, data);
    }

    /// Publishes both META feeds.
    pub fn publish_pair(&mut self, first: i128, second: i128) {
        self.publish("META", 0, first);
        self.publish("META", 1, second);
    }

    /// Publishes both META feeds at the same value.
    pub fn publish_close(&mut self, value: i128) {
        self.publish_pair(value, value);
    }

    /// The pinned META feed accounts.
    pub fn meta_feeds(&mut self) -> (Pubkey, Pubkey) {
        (self.pinned("META", 0).0, self.pinned("META", 1).0)
    }

    /// Sends `settle_market` with the pinned META feeds, paid by the harness payer.
    pub fn settle(&mut self) -> TransactionResult {
        let (a, b) = self.meta_feeds();
        self.settle_with(a, b)
    }

    /// Sends `settle_market` with explicit feed accounts.
    pub fn settle_with(&mut self, a: Pubkey, b: Pubkey) -> TransactionResult {
        let payer = self.payer.insecure_clone();
        let ix = Harness::settle_market_ix(payer.pubkey(), &self.addresses, a, b);
        self.h().send(ix, &[&payer])
    }

    /// Sends `admin_settle_override` as the admin.
    pub fn admin_override(&mut self, settle_price_cents: u64) -> TransactionResult {
        let admin = self.h().admin.insecure_clone();
        let ix = Harness::override_ix(admin.pubkey(), &self.addresses, settle_price_cents);
        self.h().send(ix, &[&admin])
    }

    /// Settles via the oracle at `value_cents` and asserts success.
    pub fn settle_at(&mut self, value_cents: u64) {
        self.publish_close(scaled_cents(value_cents));
        expect_success(&self.settle());
    }
}
