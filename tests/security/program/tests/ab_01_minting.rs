//! AB-01 (NFR-07, M1-04 AC3): YES/NO tokens cannot be minted without depositing collateral.
//! The market PDA is the only mint authority, so direct SPL `mint_to` calls fail, and every
//! substituted mint, vault, market or token account is rejected by the account constraints
//! before any token moves. The vault invariant holds after every attempt.

use anchor_lang::error::ErrorCode;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use anchor_spl::token::spl_token::error::TokenError;
use meridian::state::PAIR_COLLATERAL;
use security_tests::harness::{
    assert_anchor_error, assert_token_error, config_pda, expect_failure, expect_success, Harness,
    MarketAddresses, MarketArgs, MarketHarness, User,
};
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

const USDC: u64 = PAIR_COLLATERAL;

/// A market with one honest user holding 5 pairs, and an attacker with no tokens.
fn setup() -> (MarketHarness, MarketAddresses, User, User) {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let honest = h.harness.user_for(&addresses, 5 * USDC);
    expect_success(&h.harness.mint_pair(&honest, &addresses, 5));
    let attacker = h.harness.user_for(&addresses, 0);
    (h, addresses, honest, attacker)
}

/// A direct SPL `mint_to` of `qty` YES to `to`, signed by `authority`.
fn direct_mint_to(mint: Pubkey, to: Pubkey, authority: &Keypair, qty: u64) -> Instruction {
    spl_token::instruction::mint_to(&spl_token::ID, &mint, &to, &authority.pubkey(), &[], qty)
        .unwrap()
}

#[test]
fn direct_spl_mint_fails_for_every_signer_but_the_market_pda() {
    let (mut h, addresses, _honest, attacker) = setup();
    let admin = h.harness.admin.insecure_clone();
    let automation = h.automation.insecure_clone();
    let signers = [&attacker.keypair, &admin, &automation];
    for signer in signers {
        for mint in [addresses.yes_mint, addresses.no_mint] {
            let to = if mint == addresses.yes_mint {
                attacker.yes
            } else {
                attacker.no
            };
            let result = h
                .harness
                .send(direct_mint_to(mint, to, signer, 1), &[signer]);
            assert_token_error(&result, TokenError::OwnerMismatch);
        }
    }
    // The market PDA is off the ed25519 curve, so no private key can ever sign for it.
    assert!(!addresses.market.is_on_curve());
    assert_eq!(h.harness.token_amount(attacker.yes), 0);
    assert_eq!(h.harness.token_amount(attacker.no), 0);
    assert_eq!(h.harness.mint_supply(addresses.yes_mint), 5);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn mint_authority_of_both_mints_is_the_market_pda_and_cannot_be_changed() {
    let (mut h, addresses, _honest, attacker) = setup();
    for mint in [addresses.yes_mint, addresses.no_mint] {
        assert_eq!(
            h.harness.mint(mint).mint_authority,
            COption::Some(addresses.market)
        );
        // `set_authority` needs the current authority's signature: the market PDA's.
        let ix = spl_token::instruction::set_authority(
            &spl_token::ID,
            &mint,
            Some(&attacker.pubkey()),
            spl_token::instruction::AuthorityType::MintTokens,
            &attacker.pubkey(),
            &[],
        )
        .unwrap();
        let result = h.harness.send(ix, &[&attacker.keypair]);
        assert_token_error(&result, TokenError::OwnerMismatch);
        assert_eq!(
            h.harness.mint(mint).mint_authority,
            COption::Some(addresses.market)
        );
    }
    h.harness.assert_market_invariants(&addresses);
}

/// Sends `mint_pair` with the given accounts, signed by `user`, and asserts it fails with the
/// Anchor constraint error `expected`.
fn assert_mint_pair_rejected(
    h: &mut MarketHarness,
    user: &User,
    accounts: meridian::accounts::MintPair,
    qty: u64,
    expected: ErrorCode,
) {
    let ix = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: meridian::instruction::MintPair { qty }.data(),
    };
    let result = h.harness.send(ix, &[&user.keypair]);
    assert_anchor_error(&result, expected);
}

fn honest_mint_pair_accounts(
    addresses: &MarketAddresses,
    user: &User,
) -> meridian::accounts::MintPair {
    meridian::accounts::MintPair {
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
}

#[test]
fn mint_pair_rejects_substituted_mints_owned_by_the_attacker() {
    let (mut h, addresses, _honest, attacker) = setup();
    // The attacker's own 0-decimal mints (authority: the attacker) and matching accounts.
    let fake_yes_mint = create_attacker_mint(&mut h.harness, &attacker);
    let fake_no_mint = create_attacker_mint(&mut h.harness, &attacker);
    let fake_yes = h
        .harness
        .create_token_account(fake_yes_mint, attacker.pubkey(), 0);
    let fake_no = h
        .harness
        .create_token_account(fake_no_mint, attacker.pubkey(), 0);

    let mut accounts = honest_mint_pair_accounts(&addresses, &attacker);
    accounts.yes_mint = fake_yes_mint;
    accounts.user_yes = fake_yes;
    assert_mint_pair_rejected(&mut h, &attacker, accounts, 1, ErrorCode::ConstraintHasOne);

    let mut accounts = honest_mint_pair_accounts(&addresses, &attacker);
    accounts.no_mint = fake_no_mint;
    accounts.user_no = fake_no;
    assert_mint_pair_rejected(&mut h, &attacker, accounts, 1, ErrorCode::ConstraintHasOne);

    assert_eq!(h.harness.token_amount(fake_yes), 0);
    assert_eq!(h.harness.token_amount(fake_no), 0);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn mint_pair_rejects_a_substituted_vault() {
    let (mut h, addresses, _honest, attacker) = setup();
    let usdc_mint = h.harness.usdc_mint;
    // A USDC account the attacker controls, posing as the vault: the deposit would come back.
    let fake_vault = h
        .harness
        .create_token_account(usdc_mint, attacker.pubkey(), 0);
    h.harness
        .write_token_account(attacker.usdc, usdc_mint, attacker.pubkey(), USDC);
    let mut accounts = honest_mint_pair_accounts(&addresses, &attacker);
    accounts.vault = fake_vault;
    assert_mint_pair_rejected(&mut h, &attacker, accounts, 1, ErrorCode::ConstraintHasOne);

    // Another market's real vault is just as wrong.
    let other = h.create_market(&MarketArgs::base().with_strike(70_000));
    let mut accounts = honest_mint_pair_accounts(&addresses, &attacker);
    accounts.vault = other.vault;
    assert_mint_pair_rejected(&mut h, &attacker, accounts, 1, ErrorCode::ConstraintHasOne);

    assert_eq!(h.harness.token_amount(attacker.yes), 0);
    assert_eq!(h.harness.token_amount(fake_vault), 0);
    h.harness.assert_market_invariants(&addresses);
    h.harness.assert_market_invariants(&other);
}

#[test]
fn mint_pair_rejects_mints_and_token_accounts_of_another_market() {
    let (mut h, addresses, _honest, attacker) = setup();
    let other = h.create_market(&MarketArgs::base().with_strike(70_000));
    let attacker_other = User {
        keypair: attacker.keypair.insecure_clone(),
        usdc: attacker.usdc,
        yes: h
            .harness
            .create_token_account(other.yes_mint, attacker.pubkey(), 0),
        no: h
            .harness
            .create_token_account(other.no_mint, attacker.pubkey(), 0),
    };
    h.harness
        .write_token_account(attacker.usdc, h.harness.usdc_mint, attacker.pubkey(), USDC);

    // Market A with market B's mints.
    let mut accounts = honest_mint_pair_accounts(&addresses, &attacker_other);
    accounts.yes_mint = other.yes_mint;
    accounts.no_mint = other.no_mint;
    assert_mint_pair_rejected(&mut h, &attacker, accounts, 1, ErrorCode::ConstraintHasOne);

    // Market A's mints with token accounts of market B's mints.
    let accounts = honest_mint_pair_accounts(&addresses, &attacker_other);
    assert_mint_pair_rejected(
        &mut h,
        &attacker,
        accounts,
        1,
        ErrorCode::ConstraintTokenMint,
    );

    // A USDC account for another mint.
    let other_mint = h.harness.create_mint(6);
    let wrong_usdc = h
        .harness
        .create_token_account(other_mint, attacker.pubkey(), 100 * USDC);
    let mut accounts = honest_mint_pair_accounts(&addresses, &attacker);
    accounts.user_usdc = wrong_usdc;
    assert_mint_pair_rejected(
        &mut h,
        &attacker,
        accounts,
        1,
        ErrorCode::ConstraintTokenMint,
    );

    assert_eq!(h.harness.token_amount(attacker.yes), 0);
    assert_eq!(h.harness.token_amount(attacker_other.yes), 0);
    h.harness.assert_market_invariants(&addresses);
    h.harness.assert_market_invariants(&other);
}

#[test]
fn mint_pair_rejects_a_forged_market_account() {
    let (mut h, addresses, _honest, attacker) = setup();
    // A copy of the market's data under a key the program does not own.
    let forged = Pubkey::new_unique();
    let mut account = h.harness.svm.get_account(&addresses.market).unwrap();
    account.owner = attacker.pubkey();
    h.harness.svm.set_account(forged, account).unwrap();
    let mut accounts = honest_mint_pair_accounts(&addresses, &attacker);
    accounts.market = forged;
    assert_mint_pair_rejected(
        &mut h,
        &attacker,
        accounts,
        1,
        ErrorCode::AccountOwnedByWrongProgram,
    );

    // The same data at a program-owned key that is not the PDA fails the seeds check.
    let mut account = h.harness.svm.get_account(&addresses.market).unwrap();
    account.owner = meridian::ID;
    h.harness.svm.set_account(forged, account).unwrap();
    let mut accounts = honest_mint_pair_accounts(&addresses, &attacker);
    accounts.market = forged;
    assert_mint_pair_rejected(&mut h, &attacker, accounts, 1, ErrorCode::ConstraintSeeds);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn redeem_rejects_substituted_mints_so_the_vault_only_pays_for_real_pairs() {
    let (mut h, addresses, honest, attacker) = setup();
    // The attacker mints themselves "YES" and "NO" of their own mints and asks the vault to pay.
    let fake_yes_mint = create_attacker_mint(&mut h.harness, &attacker);
    let fake_no_mint = create_attacker_mint(&mut h.harness, &attacker);
    let fake_yes = h
        .harness
        .create_token_account(fake_yes_mint, attacker.pubkey(), 5);
    let fake_no = h
        .harness
        .create_token_account(fake_no_mint, attacker.pubkey(), 5);
    let ix = Instruction {
        program_id: meridian::ID,
        accounts: meridian::accounts::Redeem {
            market: addresses.market,
            user: attacker.pubkey(),
            user_usdc: attacker.usdc,
            user_yes: fake_yes,
            user_no: fake_no,
            yes_mint: fake_yes_mint,
            no_mint: fake_no_mint,
            vault: addresses.vault,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: meridian::instruction::Redeem {
            yes_qty: 5,
            no_qty: 5,
        }
        .data(),
    };
    let result = h.harness.send(ix, &[&attacker.keypair]);
    assert_anchor_error(&result, ErrorCode::ConstraintHasOne);

    // Real mints but the attacker's fake token accounts: the mint constraint rejects them.
    let ix = Instruction {
        program_id: meridian::ID,
        accounts: meridian::accounts::Redeem {
            market: addresses.market,
            user: attacker.pubkey(),
            user_usdc: attacker.usdc,
            user_yes: fake_yes,
            user_no: fake_no,
            yes_mint: addresses.yes_mint,
            no_mint: addresses.no_mint,
            vault: addresses.vault,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: meridian::instruction::Redeem {
            yes_qty: 5,
            no_qty: 5,
        }
        .data(),
    };
    let result = h.harness.send(ix, &[&attacker.keypair]);
    assert_anchor_error(&result, ErrorCode::ConstraintTokenMint);

    assert_eq!(h.harness.token_amount(attacker.usdc), 0);
    assert_eq!(h.harness.token_amount(addresses.vault), 5 * USDC);
    assert_eq!(h.harness.token_amount(honest.yes), 5);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn redeem_rejects_tokens_of_another_market_against_this_vault() {
    let (mut h, addresses, _honest, attacker) = setup();
    let other = h.create_market(&MarketArgs::base().with_strike(70_000));
    let attacker_other = h.harness.user_for(&other, 2 * USDC);
    expect_success(&h.harness.mint_pair(&attacker_other, &other, 2));
    // Pairs of market B presented to market A: A's has_one on its mints rejects B's mints...
    let ix = Instruction {
        program_id: meridian::ID,
        accounts: meridian::accounts::Redeem {
            market: addresses.market,
            user: attacker_other.pubkey(),
            user_usdc: attacker_other.usdc,
            user_yes: attacker_other.yes,
            user_no: attacker_other.no,
            yes_mint: other.yes_mint,
            no_mint: other.no_mint,
            vault: addresses.vault,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: meridian::instruction::Redeem {
            yes_qty: 2,
            no_qty: 2,
        }
        .data(),
    };
    let result = h.harness.send(ix, &[&attacker_other.keypair]);
    assert_anchor_error(&result, ErrorCode::ConstraintHasOne);
    // ...and B's token accounts with A's mints fail the mint constraint.
    let ix = Instruction {
        program_id: meridian::ID,
        accounts: meridian::accounts::Redeem {
            market: addresses.market,
            user: attacker_other.pubkey(),
            user_usdc: attacker_other.usdc,
            user_yes: attacker_other.yes,
            user_no: attacker_other.no,
            yes_mint: addresses.yes_mint,
            no_mint: addresses.no_mint,
            vault: addresses.vault,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: meridian::instruction::Redeem {
            yes_qty: 2,
            no_qty: 2,
        }
        .data(),
    };
    let result = h.harness.send(ix, &[&attacker_other.keypair]);
    assert_anchor_error(&result, ErrorCode::ConstraintTokenMint);
    // Nor can market B's vault be named while redeeming market A.
    let ix = Instruction {
        program_id: meridian::ID,
        accounts: meridian::accounts::Redeem {
            market: addresses.market,
            user: attacker.pubkey(),
            user_usdc: attacker.usdc,
            user_yes: attacker.yes,
            user_no: attacker.no,
            yes_mint: addresses.yes_mint,
            no_mint: addresses.no_mint,
            vault: other.vault,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: meridian::instruction::Redeem {
            yes_qty: 1,
            no_qty: 1,
        }
        .data(),
    };
    expect_failure(&h.harness.send(ix, &[&attacker.keypair]));

    assert_eq!(h.harness.token_amount(attacker_other.usdc), 0);
    h.harness.assert_market_invariants(&addresses);
    h.harness.assert_market_invariants(&other);
}

/// A 0-decimal mint whose authority is the attacker.
fn create_attacker_mint(harness: &mut Harness, attacker: &User) -> Pubkey {
    let mint = spl_token::state::Mint {
        mint_authority: COption::Some(attacker.pubkey()),
        supply: 0,
        decimals: 0,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    mint.pack_into_slice(&mut data);
    let address = Pubkey::new_unique();
    harness
        .svm
        .set_account(
            address,
            solana_sdk::account::Account {
                lamports: harness.svm.minimum_balance_for_rent_exemption(data.len()),
                data,
                owner: spl_token::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    address
}
