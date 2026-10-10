//! One module per instruction (D-022); each exports its `Accounts` struct and a handler function
//! `handle_<instruction>` (glob re-exports need unique names). `initialize_config` and `update_config` are implemented
//! here (M1-02); every other handler returns `MeridianError::NotImplemented` until its ticket.

pub mod add_strike;
pub mod admin_settle_override;
pub mod buy_no;
pub mod cancel_order;
pub mod create_strike_market;
pub mod initialize_config;
#[cfg(feature = "local-oracle")]
pub mod local_oracle_set;
pub mod migrate_config;
pub mod mint_pair;
pub mod pause;
pub mod place_order;
pub mod post_redstone_price;
pub mod redeem;
pub mod sell_no;
pub mod set_oracle_config;
pub mod settle_funds;
pub mod settle_market;
pub mod unpause;
pub mod update_config;
pub mod version;

pub use add_strike::*;
pub use admin_settle_override::*;
pub use buy_no::*;
pub use cancel_order::*;
pub use create_strike_market::*;
pub use initialize_config::*;
#[cfg(feature = "local-oracle")]
pub use local_oracle_set::*;
pub use migrate_config::*;
pub use mint_pair::*;
pub use pause::*;
pub use place_order::*;
pub use post_redstone_price::*;
pub use redeem::*;
pub use sell_no::*;
pub use set_oracle_config::*;
pub use settle_funds::*;
pub use settle_market::*;
pub use unpause::*;
pub use update_config::*;
pub use version::*;
