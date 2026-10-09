//! RedStone test payload builder (M2-15): locally generated secp256k1 signers + keccak256.
//! Test-only; never use production keys.

use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use sha3::{Digest, Keccak256};

/// RedStone marker bytes (appended to the end of every payload).
/// Must match programs/meridian/src/redstone/parser.rs REDSTONE_MARKER
/// Official RedStone marker: 0x000002ed57011e0000
const REDSTONE_MARKER: &[u8] = b"\x00\x00\x02\xed\x57\x01\x1e\x00\x00";

/// RedStone test signer: locally generated secp256k1 keypair (dev-only).
#[derive(Clone)]
pub struct TestSigner {
    signing_key: SigningKey,
    ethereum_address: [u8; 20],
}

impl TestSigner {
    /// Generates a new random test signer.
    pub fn generate() -> Self {
        let signing_key = SigningKey::random(&mut rand::thread_rng());

        // Ethereum address: last 20 bytes of keccak256(uncompressed pubkey without 0x04 prefix)
        let pk = signing_key.verifying_key().to_encoded_point(false);
        let h: [u8; 32] = Keccak256::digest(&pk.as_bytes()[1..]).into();
        let ethereum_address: [u8; 20] = h[12..].try_into().expect("address");

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
    /// Signs the given message bytes and returns the 65-byte signature (r||s||v).
    /// RedStone format: v = recovery_id + 27 (Ethereum convention).
    fn sign(&self, message: &[u8]) -> [u8; 65] {
        let digest: [u8; 32] = Keccak256::digest(message).into();
        let (sig, recid): (Signature, RecoveryId) = self
            .signing_key
            .sign_prehash_recoverable(&digest)
            .expect("signing failed");

        let mut sig65 = [0u8; 65];
        sig65[..64].copy_from_slice(&sig.to_bytes());
        sig65[64] = recid.to_byte() + 27;
        sig65
    }
}

/// RedStone data package builder for tests.
pub struct RedstonePayloadBuilder {
    feed_id: [u8; 32],
    value: u128,
    timestamp_ms: i64,
    signers: Vec<TestSigner>,
}

impl RedstonePayloadBuilder {
    /// Creates a new payload builder for the given ticker symbol.
    pub fn new(symbol: &str, value: u128, timestamp_ms: i64) -> Self {
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
    /// Official RedStone Base/standard layout: each package independently signed.
    pub fn build(self) -> Vec<u8> {
        // RedStone official format (from end backwards):
        // - REDSTONE_MARKER (9 bytes): 0x000002ed57011e0000
        // - unsigned_metadata_byte_size (3 bytes big-endian) = 0 for our tests
        // - unsigned_metadata (0 bytes for our tests)
        // - data_packages_count (2 bytes big-endian)
        // For each data package (independently signed):
        //   - signature (65 bytes: r||s||v)
        //   - data_points_count (3 bytes big-endian) = 1
        //   - data_point_value_byte_size (4 bytes big-endian) = 32
        //   - timestamp (6 bytes, milliseconds big-endian)
        //   - data_point_value (32 bytes big-endian u256)
        //   - feed_id (32 bytes)

        let mut payload = Vec::new();

        // Build each data package (one per signer, each independently signed)
        for signer in &self.signers {
            // Build signable bytes for THIS package
            let mut package_signable = Vec::new();

            // Feed ID (32 bytes)
            package_signable.extend_from_slice(&self.feed_id);

            // Value as 32-byte big-endian u256 (u128 with high 16 bytes zero per domain.md)
            let mut value_bytes = [0u8; 32];
            value_bytes[16..32].copy_from_slice(&self.value.to_be_bytes());
            package_signable.extend_from_slice(&value_bytes);

            // Timestamp (6 bytes big-endian from i64 milliseconds)
            let timestamp_bytes = self.timestamp_ms.to_be_bytes();
            package_signable.extend_from_slice(&timestamp_bytes[2..8]); // Last 6 bytes

            // Data point value byte size (4 bytes big-endian) = 32
            package_signable.extend_from_slice(&32u32.to_be_bytes());

            // Data points count (3 bytes big-endian) = 1
            let dp_count_bytes = 1u32.to_be_bytes();
            package_signable.extend_from_slice(&dp_count_bytes[1..4]); // Last 3 bytes

            // Sign THIS package's signable bytes
            let signature = signer.sign(&package_signable);

            // Add to payload: signable bytes + signature
            payload.extend_from_slice(&package_signable);
            payload.extend_from_slice(&signature);
        }

        // Data packages count (2 bytes big-endian)
        payload.extend_from_slice(&(self.signers.len() as u16).to_be_bytes());

        // Unsigned metadata (empty for tests)
        // Metadata size: 3 bytes big-endian = 0
        let metadata_size_bytes = 0u32.to_be_bytes();
        payload.extend_from_slice(&metadata_size_bytes[1..4]); // Last 3 bytes

        // RedStone marker (9 bytes)
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
        assert_eq!(&payload[payload.len() - 9..], REDSTONE_MARKER);

        // Verify minimum size (data + metadata fields + 2 signatures)
        assert!(payload.len() > 100);
    }
}
