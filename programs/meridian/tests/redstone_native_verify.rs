//! Native verification test for RedStone signatures (M2-15 diagnostic).
//! Tests signature verification WITHOUT LiteSVM to isolate data vs runtime issues.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use common::redstone::{RedstonePayloadBuilder, TestSigner};
use meridian::redstone::parser::parse_payload;
use meridian::redstone::verifier::verify_signature;

#[test]
fn native_verify_single_signer() {
    // Generate test signer and build payload
    let signer = TestSigner::generate();
    let expected_addr = signer.ethereum_address();

    let payload = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000)
        .add_signer(signer)
        .build();

    // Parse the payload using the program's parser
    let packages = parse_payload(&payload).expect("parse failed");
    assert_eq!(packages.len(), 1, "Expected 1 package");

    // Print same diagnostic info as BPF logs
    let pkg = &packages[0];
    println!("=== NATIVE VERIFY DEBUG ===");
    println!("signable_bytes.len: {}", pkg.signable_bytes.len());
    if pkg.signable_bytes.len() >= 8 {
        println!("signable_bytes[0..8]: {:?}", &pkg.signable_bytes[0..8]);
        println!(
            "signable_bytes[last 8]: {:?}",
            &pkg.signable_bytes[pkg.signable_bytes.len() - 8..]
        );
    }

    use sha3::{Digest, Keccak256};
    let hash: [u8; 32] = Keccak256::digest(&pkg.signable_bytes).into();
    println!("message_hash: {:?}", hash);
    println!("v: {}", pkg.signature[64]);
    println!(
        "recovery_id: {}",
        pkg.signature[64].checked_sub(27).unwrap()
    );

    // Verify signature using the program's verifier (native libsecp256k1)
    let recovered_addr = verify_signature(&packages[0]).expect("verify_signature failed");

    // Check recovered address matches signer's Ethereum address
    assert_eq!(
        recovered_addr, expected_addr,
        "Recovered address mismatch: got {:?}, expected {:?}",
        recovered_addr, expected_addr
    );

    println!("✓ Native verification PASSED for single signer");
}

#[test]
fn native_verify_three_of_five_signers() {
    // Generate 5 test signers, use first 3 for signing
    let signers: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let signing_addrs: Vec<[u8; 20]> = signers[..3].iter().map(|s| s.ethereum_address()).collect();

    // Build payload with first 3 signatures
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000);
    for signer in &signers[..3] {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    // Parse
    let packages = parse_payload(&payload).expect("parse failed");
    assert_eq!(packages.len(), 1, "Expected 1 package");

    // Verify the first signature (verifier processes one at a time)
    let recovered_addr = verify_signature(&packages[0]).expect("verify_signature failed");

    // Check it matches one of the signing addresses
    assert!(
        signing_addrs.contains(&recovered_addr),
        "Recovered address {:?} not in signer set",
        recovered_addr
    );

    println!("✓ Native verification PASSED for 3-of-5 signers");
}
