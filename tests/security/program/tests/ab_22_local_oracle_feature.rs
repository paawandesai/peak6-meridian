//! AB-22: the test-only local oracle must never ship in a devnet build.
//!
//! `make build-devnet` builds with default features, so the `local-oracle` feature has to stay
//! opt-in: not a default feature and not pulled in by any other feature.

const MANIFEST: &str = include_str!("../../../../programs/meridian/Cargo.toml");

/// `(name, value)` for every entry of the manifest's `[features]` table.
fn features(manifest: &str) -> Vec<(String, String)> {
    manifest
        .lines()
        .map(str::trim)
        .skip_while(|line| *line != "[features]")
        .skip(1)
        .take_while(|line| !line.starts_with('['))
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
        .collect()
}

#[test]
fn local_oracle_feature_is_declared() {
    let declared = features(MANIFEST);
    assert!(
        declared.iter().any(|(name, _)| name == "local-oracle"),
        "programs/meridian must declare the local-oracle feature: {declared:?}"
    );
}

#[test]
fn local_oracle_is_not_enabled_by_default_or_by_another_feature() {
    for (name, value) in features(MANIFEST) {
        if name != "local-oracle" {
            assert!(
                !value.contains("local-oracle"),
                "feature `{name}` must not enable local-oracle (AB-22): {value}"
            );
        }
    }
}

#[test]
fn parser_detects_a_manifest_that_enables_local_oracle_by_default() {
    let bad = "[features]\ndefault = [\"local-oracle\"]\nlocal-oracle = []\n\n[dependencies]\n";
    let enabling: Vec<String> = features(bad)
        .into_iter()
        .filter(|(name, value)| name != "local-oracle" && value.contains("local-oracle"))
        .map(|(name, _)| name)
        .collect();
    assert_eq!(enabling, vec!["default".to_owned()]);
}
