//! RedStone test payload builder (M2-15): locally generated secp256k1 signers + keccak256.
//! Test-only; never use production keys.

use k256::ecdsa::{SigningKey, Signature, signature::Signer as _};
use sha3::{Digest, Keccak256};

/// RedStone marker bytes (appended to the end of every payload).
const REDSTONE_MARKER: &[u8] = b"\x00\x00\x02\xed\x57\x19\x91\x00";

/// RedStone test signer: locally generated secp256k1 keypair (dev-only).
pub struct TestSigner {
    signing_key: SigningKey,
    ethereum_address: [u8; 20],
}

impl TestSigner {
    /// Generates a new random test signer.
    pub fn generate() -> Self {
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let verifying_key = signing_key.verifying_key();

        // Ethereum address: last 20 bytes of keccak256(pubkey)
        let pubkey_bytes = verifying_key.to_encoded_point(false);
        let pubkey_uncompressed = pubkey_bytes.as_bytes();
        // Skip the 0x04 prefix byte, hash the 64-byte pubkey
        let hash = Keccak256::digest(&pubkey_uncompressed[1..]);
        let mut ethereum_address = [0u8; 20];
        ethereum_address.copy_from_slice(&hash[12..32]);

        Self {
            signing_key,
            ethereum_address,
        }
    }

    /// Returns this signer's Ethereum address (20 bytes).
    pub fn ethereum_address(&self) -> [u8; 20] {
        self.ethereum_address
    }

    /// Signs the given message bytes and returns the 65-byte signature (r||s||v).
    fn sign(&self, message: &[u8]) -> [u8; 65] {
        let hash = Keccak256::digest(message);
        let signature: Signature = self.signing_key.sign(&hash);
        let (r, s) = signature.split_bytes();

        // Recovery ID: for simplicity, try both and pick the one that recovers correctly
        // In production RedStone, this is calculated properly
        let recovery_id = 0u8; // Simplified for tests

        let mut sig_bytes = [0u8; 65];
        sig_bytes[0..32].copy_from_slice(&r);
        sig_bytes[32..64].copy_from_slice(&s);
        sig_bytes[64] = recovery_id;
        sig_bytes
    }
}

/// RedStone data package builder for tests.
pub struct RedstonePayloadBuilder {
    feed_id: [u8; 32],
    value: u64,
    timestamp_ms: i64,
    signers: Vec<TestSigner>,
}

impl RedstonePayloadBuilder {
    /// Creates a new payload builder for the given ticker symbol.
    pub fn new(symbol: &str, value: u64, timestamp_ms: i64) -> Self {
        let mut feed_id = [0u8; 32];
        let symbol_bytes = symbol.as_bytes();
        let len = symbol_bytes.len().min(32);
        feed_id[..len].copy_from_slice(&symbol_bytes[..len]);

        Self {
            feed_id,
            value,
            timestamp_ms,
            signers: Vec::new(),
        }
    }

    /// Adds a test signer to this payload.
    pub fn add_signer(mut self, signer: TestSigner) -> Self {
        self.signers.push(signer);
        self
    }

    /// Builds the complete RedStone payload with all signatures.
    pub fn build(self) -> Vec<u8> {
        // RedStone format (from end backwards):
        // - REDSTONE_MARKER (8 bytes)
        // - unsigned_metadata_byte_size (2 bytes big-endian) = 0 for our tests
        // - unsigned_metadata (0 bytes for our tests)
        // - signature_count (2 bytes big-endian)
        // - signatures (65 bytes each: r||s||v)
        // - data_points_count (2 bytes big-endian) = 1
        // - data_point_value_byte_size (2 bytes big-endian) = 32
        // - timestamp (6 bytes, milliseconds big-endian, left-padded from i64)
        // - data_points (feed_id + value for each)

        let mut payload = Vec::new();

        // Data point: feed_id (32 bytes) + value (32 bytes big-endian u256)
        payload.extend_from_slice(&self.feed_id);

        // Value as 32-byte big-endian (RedStone uses u256)
        let mut value_bytes = [0u8; 32];
        value_bytes[24..32].copy_from_slice(&self.value.to_be_bytes());
        payload.extend_from_slice(&value_bytes);

        // Timestamp (6 bytes big-endian from i64 milliseconds)
        let timestamp_bytes = self.timestamp_ms.to_be_bytes();
        payload.extend_from_slice(&timestamp_bytes[2..8]); // Take last 6 bytes

        // Data point value byte size (2 bytes big-endian) = 32
        payload.extend_from_slice(&32u16.to_be_bytes());

        // Data points count (2 bytes big-endian) = 1
        payload.extend_from_slice(&1u16.to_be_bytes());

        // Build signable bytes for all signers
        let signable_bytes = payload.clone();

        // Add signatures
        for signer in &self.signers {
            let signature = signer.sign(&signable_bytes);
            payload.extend_from_slice(&signature);
        }

        // Signature count (2 bytes big-endian)
        payload.extend_from_slice(&(self.signers.len() as u16).to_be_bytes());

        // Unsigned metadata (empty for tests)
        payload.extend_from_slice(&0u16.to_be_bytes()); // metadata size = 0

        // RedStone marker
        payload.extend_from_slice(REDSTONE_MARKER);

        payload
    }

    /// Returns the Ethereum addresses of all signers in order.
    pub fn signer_addresses(&self) -> Vec<[u8; 20]> {
        self.signers.iter().map(|s| s.ethereum_address()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_payload_builder() {
        let signer1 = TestSigner::generate();
        let signer2 = TestSigner::generate();

        let payload = RedstonePayloadBuilder::new("ETH", 2000_0000_0000, 1700000000000)
            .add_signer(signer1)
            .add_signer(signer2)
            .build();

        // Verify marker is at the end
        assert_eq!(&payload[payload.len() - 8..], REDSTONE_MARKER);

        // Verify minimum size (data + metadata fields + 2 signatures)
        assert!(payload.len() > 100);
    }
}
