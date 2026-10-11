//! `MeridianError`: one variant per rule in docs/domain.md. Frozen by M1-02 (D-022); a new rule
//! needs a decision entry, not an ad-hoc variant.

use anchor_lang::prelude::*;

#[error_code]
pub enum MeridianError {
    // ---- scaffolding --------------------------------------------------------------------------
    #[msg("Instruction not implemented yet")]
    NotImplemented,

    // ---- authorities (AB-06, AB-19, D-030) -----------------------------------------------------
    #[msg("Signer is not the admin")]
    AdminOnly,
    #[msg("Signer is not the automation authority")]
    AutomationOnly,

    // ---- config (FR-01) -----------------------------------------------------------------------
    #[msg("USDC mint must have 6 decimals")]
    InvalidUsdcMint,
    #[msg("Ticker symbol must be non-empty upper-case ASCII, zero-padded")]
    InvalidTickerSymbol,
    #[msg("Ticker symbols must be unique")]
    DuplicateTickerSymbol,
    #[msg("Ticker slot index must be below 7")]
    InvalidTickerSlot,
    #[msg("A ticker slot is listed twice in one call")]
    DuplicateTickerSlot,
    #[msg("At most 6 ticker slots fit in one call")]
    TooManyTickerSlots,
    #[msg("max_staleness_slots must be greater than zero")]
    InvalidMaxStaleness,
    #[msg("max_conf_bps must be between 1 and 10,000")]
    InvalidMaxConfBps,

    // ---- market creation (FR-02, FR-03) -------------------------------------------------------
    #[msg("Ticker is not in the config")]
    UnknownTicker,
    #[msg("Strike must be a positive multiple of $10")]
    InvalidStrike,
    #[msg("Trading date must be a calendar date as YYYYMMDD")]
    InvalidTradingDate,
    #[msg("Close time must be in the future")]
    CloseInThePast,

    // ---- lifecycle and time (domain.md § Market lifecycle and time rules; AB-11) -------------
    #[msg("Market is closed: no minting or new orders at or after close_ts")]
    MarketClosed,
    #[msg("Trading is paused: no minting or new orders")]
    Paused,
    #[msg("Market is already settled; the outcome never changes")]
    AlreadySettled,
    #[msg("Market is not settled yet")]
    NotSettled,
    #[msg("Market has not closed yet")]
    NotClosed,

    // ---- order book (domain.md § Order book rules; AB-09, AB-10) ------------------------------
    #[msg("Price must be between 1 and 99 cents")]
    InvalidPrice,
    #[msg("Quantity must be at least 1 contract")]
    InvalidQuantity,
    #[msg("Owner already has the maximum number of resting orders in this market")]
    TooManyRestingOrders,
    #[msg("Book is full and the order does not beat the worst resting order")]
    BookFull,
    #[msg("Order not found")]
    OrderNotFound,
    #[msg("Signer does not own this order or balance")]
    NotOrderOwner,
    #[msg("Open orders balance is insufficient")]
    InsufficientOpenOrdersBalance,

    // ---- settlement (domain.md § Settlement rules; AB-03, AB-04, AB-05, AB-07, AB-08) --------
    #[msg("Oracle feed account is not owned by the Switchboard program")]
    OracleWrongOwner,
    #[msg("Oracle feed hash does not match the one pinned in the config")]
    OracleFeedHashMismatch,
    #[msg("Oracle value is older than max_staleness_slots")]
    OracleStale,
    #[msg("Oracle value was produced before close_ts")]
    OracleBeforeClose,
    #[msg("Oracle values differ by more than max_conf_bps")]
    OracleSpreadTooWide,
    #[msg("Oracle value is not a valid price")]
    OracleInvalidValue,
    #[msg("Override is not allowed before close_ts + override_delay_secs")]
    OverrideTooEarly,

    // ---- RedStone oracle (M2-15, D-054; AB-03, AB-04) -----------------------------------------
    #[msg("RedStone payload is malformed or oversized")]
    RedStoneMalformedPayload,
    #[msg("RedStone signature verification failed")]
    RedStoneInvalidSignature,
    #[msg("RedStone signer threshold not met")]
    RedStoneInsufficientSigners,
    #[msg("RedStone package timestamp is after close_ts + max_package_delay_secs")]
    RedStonePackageTooLate,
    #[msg("RedStone package timestamp is older than the stored value")]
    RedStonePackageOlderThanStored,
    #[msg("RedStone price account is not the expected PDA for this ticker")]
    RedStoneWrongPricePda,
    #[msg("RedStone feed_id does not match the canonical feed_id for this ticker")]
    RedStoneFeedIdMismatch,

    // ---- Oracle configuration (M2-15) ---------------------------------------------------------
    #[msg("Too many signers: maximum is 8")]
    OracleTooManySigners,
    #[msg("Signer threshold must be at least 1")]
    OracleThresholdTooLow,
    #[msg("Signer threshold cannot exceed the signer count")]
    OracleThresholdTooHigh,

    // ---- redeem (domain.md § Glossary: pair redeem, winner redeem; AB-02) ---------------------
    #[msg("Pair redeem needs equal YES and NO quantities before settlement")]
    PairQuantityMismatch,
    #[msg("Nothing to redeem")]
    NothingToRedeem,

    // ---- arithmetic (AB-12) -------------------------------------------------------------------
    #[msg("Arithmetic overflow")]
    MathOverflow,

    // ---- Config v2 + migration (M3-10b). Appended after every earlier variant so existing
    // error codes keep their numbers across the devnet upgrade. -------------------------------
    #[msg("pyth_max_age_secs must be greater than zero")]
    InvalidPythMaxAge,
    #[msg("Config account is already migrated to the current layout")]
    ConfigAlreadyMigrated,
    #[msg("Config account is not a v1 Config (discriminator, size or bump mismatch)")]
    ConfigLayoutMismatch,

    // ---- Pyth Lazer settlement (D-055). Appended so every earlier code keeps its number. ------
    #[msg("Pyth update is not signed by the pyth_lazer_signer pinned in the config")]
    PythWrongSigner,
    #[msg("Pyth confidence is missing or wider than max_conf_bps of the price")]
    PythConfidenceTooWide,
    #[msg("Pyth update is later than close_ts + pyth_max_age_secs")]
    PythAfterCloseWindow,
}
