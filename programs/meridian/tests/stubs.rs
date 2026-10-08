//! M1-02 AC3: every instruction from architecture.md § Interfaces exists in the IDL built by
//! `make build-local`, and every one not implemented yet returns `MeridianError::NotImplemented`.
//! Implemented so far: config (M1-02); markets, mint/redeem (pair mode) and pause (M1-04);
//! settlement, override, winner redeem and the local oracle (M1-07).

// Test code: the program rules on unwrap/panic/arithmetic do not apply here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

mod common;

use anchor_lang::solana_program::hash::hash;
use anchor_lang::InstructionData;
use common::{assert_meridian_error, Harness};
use meridian::errors::MeridianError;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::Signer;

/// Every instruction of the local build, in architecture.md order.
const EXPECTED_INSTRUCTIONS: [&str; 17] = [
    "initialize_config",
    "update_config",
    "create_strike_market",
    "add_strike",
    "mint_pair",
    "place_order",
    "cancel_order",
    "settle_funds",
    "buy_no",
    "sell_no",
    "settle_market",
    "admin_settle_override",
    "redeem",
    "pause",
    "unpause",
    "local_oracle_set",
    "version",
];

/// Instruction names from the IDL written by `anchor build`.
fn idl_instruction_names() -> Vec<String> {
    let path = common::repo_root().join("target/idl/meridian.json");
    let idl = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "cannot read {}: {error}; run make build-local",
            path.display()
        )
    });
    let mut names = Vec::new();
    let marker = "\"name\": \"";
    let instructions = idl
        .split("\"instructions\": [")
        .nth(1)
        .expect("instructions array")
        .split("\n  ],")
        .next()
        .expect("end of instructions array");
    // Instruction entries are at indentation 4; nested names (accounts, args) are deeper.
    for line in instructions.lines() {
        if let Some(rest) = line.strip_prefix(&format!("      {marker}")) {
            if let Some(name) = rest.strip_suffix("\",") {
                names.push(name.to_owned());
            }
        }
    }
    names
}

#[test]
fn idl_lists_every_instruction_of_the_interface() {
    let mut names = idl_instruction_names();
    names.sort();
    let mut expected: Vec<String> = EXPECTED_INSTRUCTIONS
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    expected.sort();
    assert_eq!(names, expected);
}

/// `(name, data)` of every stub instruction with valid arguments.
fn stub_instructions() -> Vec<(&'static str, Vec<u8>)> {
    // Every instruction is implemented (M1-02 … M1-07); a future stub goes here.
    Vec::new()
}

#[test]
fn every_stub_is_covered_by_this_test() {
    let implemented = [
        "initialize_config",
        "update_config",
        "version",
        "create_strike_market",
        "add_strike",
        "mint_pair",
        "redeem",
        "pause",
        "unpause",
        "settle_market",
        "admin_settle_override",
        "local_oracle_set",
        "place_order",
        "cancel_order",
        "settle_funds",
        "buy_no",
        "sell_no",
    ];
    let mut covered: Vec<&str> = stub_instructions()
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    covered.extend(implemented);
    covered.sort();
    let mut expected = EXPECTED_INSTRUCTIONS.to_vec();
    expected.sort();
    assert_eq!(covered, expected);
}

#[test]
fn every_stub_returns_not_implemented() {
    let mut harness = Harness::new();
    let signer = harness.funded_keypair();
    let accounts = vec![anchor_lang::prelude::AccountMeta::new(
        signer.pubkey(),
        true,
    )];
    for (name, data) in stub_instructions() {
        let instruction = Instruction {
            program_id: meridian::ID,
            accounts: accounts.clone(),
            data,
        };
        let result = harness.send(instruction, &[&signer]);
        assert_meridian_error(&result, MeridianError::NotImplemented);
        assert!(
            result.is_err(),
            "{name} must fail until its ticket implements it"
        );
    }
}

#[test]
fn stub_discriminators_match_their_names() {
    // The hand-built local_oracle_set data above relies on Anchor's discriminator rule; prove
    // it against a generated one.
    let generated = meridian::instruction::SettleFunds {}.data();
    assert_eq!(
        &generated[..8],
        &hash(b"global:settle_funds").to_bytes()[..8]
    );
}
