//! Pyth Lazer settlement helpers (M3-10b, D-055): a signed `PayloadData` message, the native
//! Ed25519Program instruction that carries it, and `settle_market` on the Pyth path. The test
//! signer is a plain Solana keypair (ed25519), pinned in the Config as `pyth_lazer_signer`.
//! Included through `common/mod.rs`.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::sysvar;
use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::types::TransactionResult;
use meridian::pyth::{ED25519_PROGRAM_ID, PAYLOAD_FORMAT_MAGIC};
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::transaction::Transaction;

use super::settlement::SettlementHarness;
use super::{config_pda, MarketAddresses};

/// META's numeric Pyth Pro feed id (config slot 5).
pub const META_FEED_ID: u32 = meridian::pyth::feed_ids::META;
/// Pyth exponent used by the fixtures: prices carry 8 fractional digits.
pub const PYTH_EXPONENT: i16 = -8;

/// A Pyth Lazer `PayloadData` with one feed carrying a Price and an Exponent property.
pub fn pyth_payload(feed_id: u32, price: i64, exponent: i16, timestamp_us: i64) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&PAYLOAD_FORMAT_MAGIC.to_le_bytes());
    out.extend_from_slice(&timestamp_us.to_le_bytes());
    out.push(1); // channel id
    out.push(1); // one feed
    out.extend_from_slice(&feed_id.to_le_bytes());
    out.push(2); // two properties
    out.push(0); // Price: Option<i64>
    out.push(1);
    out.extend_from_slice(&price.to_le_bytes());
    out.push(4); // Exponent: i16
    out.extend_from_slice(&exponent.to_le_bytes());
    out
}

/// A native Ed25519Program instruction verifying `signer`'s signature over `message`, with every
/// offset pointing into this instruction (index `u16::MAX`), as `new_ed25519_instruction` lays
/// it out: 16-byte header, public key at 16, signature at 48, message at 112.
pub fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
    const PUBKEY_OFFSET: u16 = 16;
    const SIGNATURE_OFFSET: u16 = 48;
    const MESSAGE_OFFSET: u16 = 112;
    let signature = signer.sign_message(message);
    let mut data = vec![1u8, 0];
    for value in [
        SIGNATURE_OFFSET,
        u16::MAX,
        PUBKEY_OFFSET,
        u16::MAX,
        MESSAGE_OFFSET,
        u16::try_from(message.len()).unwrap(),
        u16::MAX,
    ] {
        data.extend_from_slice(&value.to_le_bytes());
    }
    data.extend_from_slice(&signer.pubkey().to_bytes());
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);
    Instruction {
        program_id: ED25519_PROGRAM_ID,
        accounts: vec![],
        data,
    }
}

/// `settle_market` on the Pyth path: the instructions sysvar and the Ed25519 instruction index.
pub fn settle_market_pyth_ix(
    payer: Pubkey,
    addresses: &MarketAddresses,
    ed25519_ix_index: u16,
) -> Instruction {
    Instruction {
        program_id: meridian::ID,
        accounts: meridian::accounts::SettleMarket {
            config: config_pda(),
            market: addresses.market,
            feed_tiingo: Pubkey::default(),
            feed_twelve_data: Pubkey::default(),
            redstone_price: None,
            oracle_config: None,
            instructions_sysvar: Some(sysvar::instructions::ID),
            payer,
        }
        .to_account_metas(None),
        data: meridian::instruction::SettleMarket {
            ed25519_ix_index: Some(ed25519_ix_index),
        }
        .data(),
    }
}

impl SettlementHarness {
    /// Sends `[ed25519 verify(message by signer), settle_market(pyth, index 0)]`.
    pub fn settle_pyth_signed(&mut self, signer: &Keypair, message: &[u8]) -> TransactionResult {
        let payer = self.payer.insecure_clone();
        let addresses = self.addresses;
        let instructions = [
            ed25519_ix(signer, message),
            settle_market_pyth_ix(payer.pubkey(), &addresses, 0),
        ];
        let h = self.h();
        h.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &instructions,
            Some(&payer.pubkey()),
            &[&payer],
            h.svm.latest_blockhash(),
        );
        h.svm.send_transaction(tx)
    }

    /// Settles META via Pyth with a price published at the current clock time.
    pub fn settle_pyth(&mut self, signer: &Keypair, price: i64) -> TransactionResult {
        let now = self.h().clock().unix_timestamp;
        let message = pyth_payload(META_FEED_ID, price, PYTH_EXPONENT, now * 1_000_000);
        self.settle_pyth_signed(signer, &message)
    }
}
