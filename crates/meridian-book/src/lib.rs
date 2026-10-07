//! Meridian matching engine: pure Rust, no Solana types (D-002, D-022).
//!
//! One [`Book`] per market holds up to [`SIDE_CAPACITY`] resting orders per side. [`Book::place`]
//! matches a new order against the opposite side with price-time priority and returns fill and
//! cancellation records; [`Book::cancel`] removes a resting order for its owner. The engine never
//! moves funds: the program applies escrow, credits and refunds from the returned records
//! (domain.md § Order book rules, FR-05, NFR-09).

#![forbid(unsafe_code)]

mod book;

pub use book::{
    Book, BookError, CancelReason, Cancelled, Fill, Order, OrderKind, Owner, PlaceResult, Side,
    MAX_FILLS_PER_PLACE, MAX_ORDERS_PER_OWNER, MAX_PRICE, MIN_ORDER_QTY, MIN_PRICE, SIDE_CAPACITY,
};

/// Version of this crate, taken from its `Cargo.toml`.
pub fn crate_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::crate_version;

    #[test]
    fn crate_version_matches_manifest() {
        let manifest = include_str!("../../../Cargo.toml");
        let expected = manifest
            .lines()
            .find_map(|line| line.strip_prefix("version = "))
            .map(|value| value.trim_matches('"'));
        assert_eq!(Some(crate_version()), expected);
    }

    #[test]
    fn crate_version_is_semver() {
        let parts: Vec<&str> = crate_version().split('.').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|part| part.parse::<u32>().is_ok()));
    }
}
