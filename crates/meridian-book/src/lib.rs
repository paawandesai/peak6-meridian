//! Meridian matching engine: pure Rust, no Solana types.
//!
//! M1-01 placeholder: the order book arrives with M1-03.

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
