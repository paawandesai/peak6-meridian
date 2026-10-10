//! On-chain accounts (architecture.md § Data model). Frozen by M1-02 (D-022): later tickets
//! change behaviour in their own instruction files, not here.

pub mod book;
pub mod config;
pub mod market;
pub mod open_orders;
pub mod oracle_config;
pub mod redstone_price;

pub use book::*;
pub use config::*;
pub use market::*;
pub use open_orders::*;
pub use oracle_config::*;
pub use redstone_price::*;
