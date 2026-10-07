//! AB-22 (NFR-14; M1-07 AC3): the test-only local oracle never ships in a devnet build.
//!
//! Three layers: the manifest keeps the feature opt-in (`ab_22_local_oracle_feature.rs`), the
//! source gates every use of the instruction behind the feature (this file), and the CI job
//! `build-devnet-check` builds with `make build-devnet` and asserts the IDL lacks
//! `local_oracle_set`. When `MERIDIAN_DEVNET_IDL` names that IDL, this file checks it too.

const LIB: &str = include_str!("../../../../programs/meridian/src/lib.rs");
const INSTRUCTIONS: &str = include_str!("../../../../programs/meridian/src/instructions/mod.rs");
const ORACLE: &str = include_str!("../../../../programs/meridian/src/oracle.rs");
const GATE: &str = "#[cfg(feature = \"local-oracle\")]";

/// Names of the IDL's instructions (entries of the `instructions` array).
fn idl_instruction_names(idl: &str) -> Vec<String> {
    let json: serde_json::Value = serde_json::from_str(idl).expect("IDL is JSON");
    json["instructions"]
        .as_array()
        .expect("instructions array")
        .iter()
        .map(|entry| entry["name"].as_str().expect("name").to_owned())
        .collect()
}

/// True when every line that mentions `needle` is preceded by the feature gate (attributes and
/// doc comments may sit in between).
fn every_mention_is_gated(source: &str, needle: &str) -> bool {
    let lines: Vec<&str> = source.lines().map(str::trim).collect();
    lines.iter().enumerate().all(|(index, line)| {
        if !line.contains(needle) || line.starts_with("//") {
            return true;
        }
        lines[..index]
            .iter()
            .rev()
            .take_while(|previous| previous.starts_with("#[") || previous.starts_with("///"))
            .any(|previous| *previous == GATE)
    })
}

#[test]
fn local_oracle_set_is_gated_in_the_source() {
    for needle in ["pub fn local_oracle_set", "mod local_oracle_set", "use local_oracle_set"] {
        assert!(every_mention_is_gated(LIB, needle), "lib.rs: {needle}");
        assert!(
            every_mention_is_gated(INSTRUCTIONS, needle),
            "instructions/mod.rs: {needle}"
        );
    }
    assert!(
        every_mention_is_gated(ORACLE, "pub struct LocalFeed"),
        "the local feed account type must be feature-gated"
    );
}

#[test]
fn the_gate_check_detects_an_ungated_instruction() {
    let bad = "pub fn local_oracle_set(ctx: Ctx) {}\n";
    assert!(!every_mention_is_gated(bad, "pub fn local_oracle_set"));
    let good = format!("{GATE}\npub fn local_oracle_set(ctx: Ctx) {{}}\n");
    assert!(every_mention_is_gated(&good, "pub fn local_oracle_set"));
}

#[test]
fn idl_parser_lists_instruction_names() {
    let idl = r#"{"instructions":[{"name":"settle_market"},{"name":"local_oracle_set"}]}"#;
    assert_eq!(
        idl_instruction_names(idl),
        vec!["settle_market".to_owned(), "local_oracle_set".to_owned()]
    );
}

/// Runs in the `build-devnet-check` CI job after `make build-devnet`.
#[test]
fn devnet_idl_has_no_local_oracle_set() {
    let Ok(path) = std::env::var("MERIDIAN_DEVNET_IDL") else {
        eprintln!("MERIDIAN_DEVNET_IDL not set: skipping the built-IDL check (CI sets it)");
        return;
    };
    let idl = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"));
    let names = idl_instruction_names(&idl);
    assert!(
        names.iter().any(|name| name == "settle_market"),
        "not a Meridian IDL: {names:?}"
    );
    assert!(
        !names.iter().any(|name| name == "local_oracle_set"),
        "devnet IDL lists local_oracle_set (AB-22): {names:?}"
    );
}
