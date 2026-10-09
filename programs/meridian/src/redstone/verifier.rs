//! RedStone signature verification using secp256k1_recover syscall (M2-15).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;

use crate::errors::MeridianError;
use super::parser::RedstonePackage;

/// Verify RedStone package signature and recover Ethereum address.
///
/// Steps:
/// 1. Compute keccak256 hash of signable bytes
/// 2. Call secp256k1_recover syscall
/// 3. Compute Ethereum address (last 20 bytes of keccak256(pubkey))
pub fn verify_signature(package: &RedstonePackage) -> Result<[u8; 20]> {
    use anchor_lang::solana_program::secp256k1_recover::{
        secp256k1_recover, Secp256k1Pubkey,
    };

    // Compute keccak256 hash of signable bytes
    let message_hash = keccak::hash(&package.signable_bytes);

    // Extract v from signature byte 64 and convert to recovery_id
    // RedStone uses Ethereum convention: v = 27 or 28
    // Solana secp256k1_recover expects recovery_id = 0 or 1
    let v = package.signature[64];
    let recovery_id = v.checked_sub(27)
        .ok_or(MeridianError::RedStoneInvalidSignature)?;

    // Prepare signature (r‖s, 64 bytes)
    let mut sig_bytes = [0u8; 64];
    sig_bytes.copy_from_slice(&package.signature[..64]);

    // Call secp256k1_recover syscall
    let pubkey: Secp256k1Pubkey = secp256k1_recover(
        message_hash.as_ref(),
        recovery_id,
        &sig_bytes,
    )
    .map_err(|_| MeridianError::RedStoneInvalidSignature)?;

    // Ethereum address = last 20 bytes of keccak256(pubkey)
    let pubkey_hash = keccak::hash(&pubkey.0);
    let mut eth_address = [0u8; 20];
    eth_address.copy_from_slice(&pubkey_hash.as_ref()[12..32]);

    Ok(eth_address)
}

/// Compute median of values (for threshold signers).
pub fn compute_median(mut values: Vec<u64>) -> u64 {
    values.sort_unstable();
    let len = values.len();
    if len % 2 == 0 {
        (values[len / 2 - 1] + values[len / 2]) / 2
    } else {
        values[len / 2]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_median_odd() {
        assert_eq!(compute_median(vec![1, 3, 2]), 2);
    }

    #[test]
    fn test_median_even() {
        assert_eq!(compute_median(vec![1, 2, 3, 4]), 2);
    }
}
