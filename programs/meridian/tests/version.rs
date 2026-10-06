//! `version` instruction: success and failure paths.
//!
//! The instruction touches no accounts, so these tests drive the program's real entrypoint
//! natively. Stateful instructions (M1-02 onwards) are tested against the built program.

use std::process::Command;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::*;
use anchor_lang::InstructionData;

/// Set in the child process that `version_logs_the_crate_version` spawns.
const CHILD_ENV: &str = "MERIDIAN_VERSION_TEST_CHILD";

fn version_ix_data() -> Vec<u8> {
    meridian::instruction::Version {}.data()
}

fn custom_error(code: ErrorCode) -> ProgramError {
    ProgramError::Custom(code.into())
}

#[test]
fn version_succeeds() {
    assert_eq!(
        meridian::entry(&meridian::ID, &[], &version_ix_data()),
        Ok(())
    );
    assert_eq!(meridian::VERSION, env!("CARGO_PKG_VERSION"));
}

/// Off-chain, `msg!` prints to stdout. The test re-runs itself in a child process, where it only
/// calls the instruction, and asserts on what the child printed.
#[test]
fn version_logs_the_crate_version() {
    if std::env::var_os(CHILD_ENV).is_some() {
        assert_eq!(
            meridian::entry(&meridian::ID, &[], &version_ix_data()),
            Ok(())
        );
        return;
    }

    let output = Command::new(std::env::current_exe().unwrap())
        .env(CHILD_ENV, "1")
        .args(["--exact", "version_logs_the_crate_version", "--nocapture"])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();

    assert!(output.status.success(), "child failed: {stdout}");
    let expected = format!("meridian {}", env!("CARGO_PKG_VERSION"));
    assert!(
        stdout.lines().any(|line| line == expected),
        "expected a log line {expected:?} in:\n{stdout}"
    );
}

#[test]
fn unknown_instruction_is_rejected() {
    assert_eq!(
        meridian::entry(&meridian::ID, &[], &[0xff; 8]),
        Err(custom_error(ErrorCode::InstructionFallbackNotFound))
    );
}

#[test]
fn empty_instruction_data_is_rejected() {
    assert_eq!(
        meridian::entry(&meridian::ID, &[], &[]),
        Err(custom_error(ErrorCode::InstructionFallbackNotFound))
    );
}

#[test]
fn call_under_another_program_id_is_rejected() {
    assert_eq!(
        meridian::entry(&Pubkey::new_unique(), &[], &version_ix_data()),
        Err(custom_error(ErrorCode::DeclaredProgramIdMismatch))
    );
}
