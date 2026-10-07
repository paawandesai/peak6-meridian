//! Abuse-case tests for the Meridian program live in `tests/`, one file per AB ID
//! (see docs/threat-model.md). This library only re-exports the LiteSVM harness that the
//! program's own tests define, so both suites drive the program the same way.

#[path = "../../../../programs/meridian/tests/common/mod.rs"]
pub mod harness;
