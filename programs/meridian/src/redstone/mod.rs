//! RedStone oracle payload parsing and signature verification (M2-15, D-054).
//!
//! RedStone data package format:
//! - Data points: [feed_id (32 bytes), value (u256 big-endian, 8 decimals)]
//! - Timestamp: 6 bytes (milliseconds)
//! - Data point value size: 32 bytes (u256)
//! - Data point count
//! - Signatures: 65 bytes each (r‖s‖v format)
//! - Unsigned metadata
//! - RedStone marker: 9 bytes
//!
//! Verification steps:
//! 1. Parse payload structure
//! 2. For each signature: keccak256(signable_bytes), secp256k1_recover → Ethereum address
//! 3. Count valid signers (in pinned set, same timestamp, same feed id)
//! 4. Check threshold
//! 5. Compute median of valid values

pub mod parser;
pub mod verifier;

pub use parser::*;
pub use verifier::*;
