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
    // Compute keccak256 of signable bytes
    let message_hash = keccak::hash(&package.signable_bytes);

    // TODO(M2-15): secp256k1_recover syscall
    // recovery_id = signature[64]
    // Call secp256k1_recover(message_hash, signature[..64], recovery_id)
    // Get recovered pubkey (64 bytes)
    // Ethereum address = last 20 bytes of keccak256(pubkey)

    Err(MeridianError::NotImplemented.into())
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
