/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/meridian.json`.
 */
export type Meridian = {
  address: "3RovidBTwYzUfhniunxsUgnLzsbWz6qt3PGpvD23HDZq";
  metadata: {
    name: "meridian";
    version: "0.1.0";
    spec: "0.1.0";
    description: "Meridian on-chain program";
  };
  instructions: [
    {
      name: "addStrike";
      docs: ["Admin adds a strike before close (FR-03). Stub until M1-04."];
      discriminator: [226, 190, 94, 4, 5, 106, 15, 120];
      accounts: [
        {
          name: "admin";
          docs: ["The admin."];
          signer: true;
        },
      ];
      args: [
        {
          name: "ticker";
          type: {
            array: ["u8", 8];
          };
        },
        {
          name: "strikeCents";
          type: "u64";
        },
        {
          name: "tradingDate";
          type: "u32";
        },
        {
          name: "closeTs";
          type: "i64";
        },
      ];
    },
    {
      name: "adminSettleOverride";
      docs: ["Admin settlement with a manual price after the delay (FR-09). Stub until M1-07."];
      discriminator: [92, 131, 189, 52, 161, 70, 203, 95];
      accounts: [
        {
          name: "admin";
          docs: ["The admin."];
          signer: true;
        },
      ];
      args: [
        {
          name: "settlePriceCents";
          type: "u64";
        },
      ];
    },
    {
      name: "buyNo";
      docs: ["Mint pair + sell YES (FR-06). Stub until M1-06."];
      discriminator: [89, 240, 244, 16, 196, 201, 190, 163];
      accounts: [
        {
          name: "user";
          docs: ["The user buying NO."];
          signer: true;
        },
      ];
      args: [
        {
          name: "qty";
          type: "u64";
        },
        {
          name: "price";
          type: "u8";
        },
        {
          name: "kind";
          type: {
            defined: {
              name: "orderKind";
            };
          };
        },
      ];
    },
    {
      name: "cancelOrder";
      docs: ["Cancels the owner's resting order (FR-05). Stub until M1-05."];
      discriminator: [95, 129, 237, 240, 8, 49, 223, 132];
      accounts: [
        {
          name: "owner";
          docs: ["The order owner."];
          signer: true;
        },
      ];
      args: [
        {
          name: "orderId";
          type: "u64";
        },
      ];
    },
    {
      name: "createStrikeMarket";
      docs: ["Automation authority creates one strike market (FR-02). Stub until M1-04."];
      discriminator: [21, 162, 50, 119, 68, 218, 221, 35];
      accounts: [
        {
          name: "automationAuthority";
          docs: ["The automation authority (D-030)."];
          signer: true;
        },
      ];
      args: [
        {
          name: "ticker";
          type: {
            array: ["u8", 8];
          };
        },
        {
          name: "strikeCents";
          type: "u64";
        },
        {
          name: "tradingDate";
          type: "u32";
        },
        {
          name: "closeTs";
          type: "i64";
        },
      ];
    },
    {
      name: "initializeConfig";
      docs: ["Creates the config; the payer becomes the admin (FR-01)."];
      discriminator: [208, 127, 21, 1, 194, 190, 196, 70];
      accounts: [
        {
          name: "config";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "admin";
          docs: ["The deployer; becomes the admin."];
          writable: true;
          signer: true;
        },
        {
          name: "usdcMint";
          docs: ["Test-USDC mint; must have 6 decimals (domain.md § Units)."];
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "params";
          type: {
            defined: {
              name: "configParams";
            };
          };
        },
      ];
    },
    {
      name: "localOracleSet";
      docs: ["Test-only oracle writer; never in devnet builds (D-028, AB-22). Stub until M1-07."];
      discriminator: [91, 149, 169, 250, 188, 137, 130, 242];
      accounts: [
        {
          name: "authority";
          docs: ["The local oracle writer (test only)."];
          signer: true;
        },
      ];
      args: [
        {
          name: "ticker";
          type: {
            array: ["u8", 8];
          };
        },
        {
          name: "sourceSlot";
          type: "u8";
        },
        {
          name: "value";
          type: "i128";
        },
        {
          name: "slot";
          type: "u64";
        },
      ];
    },
    {
      name: "mintPair";
      docs: ["Deposits `qty` USDC and mints `qty` YES + `qty` NO (FR-04). Stub until M1-04."];
      discriminator: [19, 149, 94, 110, 181, 186, 33, 107];
      accounts: [
        {
          name: "user";
          docs: ["The user depositing USDC."];
          signer: true;
        },
      ];
      args: [
        {
          name: "qty";
          type: "u64";
        },
      ];
    },
    {
      name: "pause";
      docs: ["Global pause (FR-11). Stub until M1-04."];
      discriminator: [211, 22, 221, 251, 74, 121, 193, 47];
      accounts: [
        {
          name: "admin";
          docs: ["The admin."];
          signer: true;
        },
      ];
      args: [];
    },
    {
      name: "placeOrder";
      docs: ["Places a YES bid or ask, limit or IOC (FR-05). Stub until M1-05."];
      discriminator: [51, 194, 155, 175, 109, 130, 96, 106];
      accounts: [
        {
          name: "user";
          docs: ["The order owner."];
          signer: true;
        },
      ];
      args: [
        {
          name: "side";
          type: {
            defined: {
              name: "side";
            };
          };
        },
        {
          name: "price";
          type: "u8";
        },
        {
          name: "qty";
          type: "u64";
        },
        {
          name: "kind";
          type: {
            defined: {
              name: "orderKind";
            };
          };
        },
      ];
    },
    {
      name: "redeem";
      docs: [
        "Pair redeem before settlement, winner redeem after (FR-10). Stub until M1-04 / M1-07.",
      ];
      discriminator: [184, 12, 86, 149, 70, 196, 97, 225];
      accounts: [
        {
          name: "user";
          docs: ["The user redeeming."];
          signer: true;
        },
      ];
      args: [
        {
          name: "yesQty";
          type: "u64";
        },
        {
          name: "noQty";
          type: "u64";
        },
      ];
    },
    {
      name: "sellNo";
      docs: ["IOC buy YES with a price cap + pair redeem (FR-07). Stub until M1-06."];
      discriminator: [189, 194, 132, 42, 80, 249, 154, 103];
      accounts: [
        {
          name: "user";
          docs: ["The user selling NO."];
          signer: true;
        },
      ];
      args: [
        {
          name: "qty";
          type: "u64";
        },
        {
          name: "price";
          type: "u8";
        },
      ];
    },
    {
      name: "settleFunds";
      docs: ["Withdraws the owner's free balances (FR-12, D-029). Stub until M1-05."];
      discriminator: [238, 64, 163, 96, 75, 171, 16, 33];
      accounts: [
        {
          name: "owner";
          docs: ["The open orders owner."];
          signer: true;
        },
      ];
      args: [];
    },
    {
      name: "settleMarket";
      docs: ["Permissionless settlement from the two oracle feeds (FR-08). Stub until M1-07."];
      discriminator: [193, 153, 95, 216, 166, 6, 144, 217];
      accounts: [
        {
          name: "payer";
          docs: ["Anyone: settlement is permissionless (D-030)."];
          signer: true;
        },
      ];
      args: [];
    },
    {
      name: "unpause";
      docs: ["Lifts the global pause (FR-11). Stub until M1-04."];
      discriminator: [169, 144, 4, 38, 10, 141, 188, 255];
      accounts: [
        {
          name: "admin";
          docs: ["The admin."];
          signer: true;
        },
      ];
      args: [];
    },
    {
      name: "updateConfig";
      docs: ["Admin replaces every configurable field except the admin itself (FR-01, AB-06)."];
      discriminator: [29, 158, 252, 191, 10, 83, 219, 99];
      accounts: [
        {
          name: "config";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "admin";
          signer: true;
          relations: ["config"];
        },
        {
          name: "usdcMint";
          docs: ["Test-USDC mint; must have 6 decimals (domain.md § Units)."];
        },
      ];
      args: [
        {
          name: "params";
          type: {
            defined: {
              name: "configParams";
            };
          };
        },
      ];
    },
    {
      name: "version";
      docs: ["Logs the crate version. Kept until M1-10: the e2e placeholder calls it."];
      discriminator: [118, 65, 195, 198, 129, 216, 252, 192];
      accounts: [];
      args: [];
    },
  ];
  accounts: [
    {
      name: "config";
      discriminator: [155, 12, 170, 224, 30, 250, 204, 130];
    },
  ];
  events: [
    {
      name: "configInitialized";
      discriminator: [181, 49, 200, 156, 19, 167, 178, 91];
    },
    {
      name: "configUpdated";
      discriminator: [40, 241, 230, 122, 11, 19, 198, 194];
    },
    {
      name: "fill";
      discriminator: [78, 225, 199, 154, 86, 219, 224, 169];
    },
    {
      name: "fundsSettled";
      discriminator: [24, 77, 58, 215, 113, 149, 47, 216];
    },
    {
      name: "marketCreated";
      discriminator: [88, 184, 130, 231, 226, 84, 6, 58];
    },
    {
      name: "marketSettled";
      discriminator: [237, 212, 22, 175, 201, 117, 215, 99];
    },
    {
      name: "orderCancelled";
      discriminator: [108, 56, 128, 68, 168, 113, 168, 239];
    },
    {
      name: "orderPlaced";
      discriminator: [96, 130, 204, 234, 169, 219, 216, 227];
    },
    {
      name: "pairsMinted";
      discriminator: [108, 154, 184, 215, 50, 138, 35, 141];
    },
    {
      name: "paused";
      discriminator: [172, 248, 5, 253, 49, 255, 255, 232];
    },
    {
      name: "redeemed";
      discriminator: [14, 29, 183, 71, 31, 165, 107, 38];
    },
    {
      name: "unpaused";
      discriminator: [156, 150, 47, 174, 120, 216, 93, 117];
    },
  ];
  errors: [
    {
      code: 6000;
      name: "notImplemented";
      msg: "Instruction not implemented yet";
    },
    {
      code: 6001;
      name: "adminOnly";
      msg: "Signer is not the admin";
    },
    {
      code: 6002;
      name: "automationOnly";
      msg: "Signer is not the automation authority";
    },
    {
      code: 6003;
      name: "invalidUsdcMint";
      msg: "USDC mint must have 6 decimals";
    },
    {
      code: 6004;
      name: "invalidTickerSymbol";
      msg: "Ticker symbol must be non-empty upper-case ASCII, zero-padded";
    },
    {
      code: 6005;
      name: "duplicateTickerSymbol";
      msg: "Ticker symbols must be unique";
    },
    {
      code: 6006;
      name: "invalidTickerSlot";
      msg: "Ticker slot index must be below 7";
    },
    {
      code: 6007;
      name: "duplicateTickerSlot";
      msg: "A ticker slot is listed twice in one call";
    },
    {
      code: 6008;
      name: "tooManyTickerSlots";
      msg: "At most 6 ticker slots fit in one call";
    },
    {
      code: 6009;
      name: "invalidMaxStaleness";
      msg: "max_staleness_slots must be greater than zero";
    },
    {
      code: 6010;
      name: "invalidMaxConfBps";
      msg: "max_conf_bps must be between 1 and 10,000";
    },
    {
      code: 6011;
      name: "unknownTicker";
      msg: "Ticker is not in the config";
    },
    {
      code: 6012;
      name: "invalidStrike";
      msg: "Strike must be a positive multiple of $10";
    },
    {
      code: 6013;
      name: "invalidTradingDate";
      msg: "Trading date must be a calendar date as YYYYMMDD";
    },
    {
      code: 6014;
      name: "closeInThePast";
      msg: "Close time must be in the future";
    },
    {
      code: 6015;
      name: "marketClosed";
      msg: "Market is closed: no minting or new orders at or after close_ts";
    },
    {
      code: 6016;
      name: "paused";
      msg: "Trading is paused: no minting or new orders";
    },
    {
      code: 6017;
      name: "alreadySettled";
      msg: "Market is already settled; the outcome never changes";
    },
    {
      code: 6018;
      name: "notSettled";
      msg: "Market is not settled yet";
    },
    {
      code: 6019;
      name: "notClosed";
      msg: "Market has not closed yet";
    },
    {
      code: 6020;
      name: "invalidPrice";
      msg: "Price must be between 1 and 99 cents";
    },
    {
      code: 6021;
      name: "invalidQuantity";
      msg: "Quantity must be at least 1 contract";
    },
    {
      code: 6022;
      name: "tooManyRestingOrders";
      msg: "Owner already has the maximum number of resting orders in this market";
    },
    {
      code: 6023;
      name: "bookFull";
      msg: "Book is full and the order does not beat the worst resting order";
    },
    {
      code: 6024;
      name: "orderNotFound";
      msg: "Order not found";
    },
    {
      code: 6025;
      name: "notOrderOwner";
      msg: "Signer does not own this order or balance";
    },
    {
      code: 6026;
      name: "insufficientOpenOrdersBalance";
      msg: "Open orders balance is insufficient";
    },
    {
      code: 6027;
      name: "oracleWrongOwner";
      msg: "Oracle feed account is not owned by the Switchboard program";
    },
    {
      code: 6028;
      name: "oracleFeedHashMismatch";
      msg: "Oracle feed hash does not match the one pinned in the config";
    },
    {
      code: 6029;
      name: "oracleStale";
      msg: "Oracle value is older than max_staleness_slots";
    },
    {
      code: 6030;
      name: "oracleBeforeClose";
      msg: "Oracle value was produced before close_ts";
    },
    {
      code: 6031;
      name: "oracleSpreadTooWide";
      msg: "Oracle values differ by more than max_conf_bps";
    },
    {
      code: 6032;
      name: "oracleInvalidValue";
      msg: "Oracle value is not a valid price";
    },
    {
      code: 6033;
      name: "overrideTooEarly";
      msg: "Override is not allowed before close_ts + override_delay_secs";
    },
    {
      code: 6034;
      name: "pairQuantityMismatch";
      msg: "Pair redeem needs equal YES and NO quantities before settlement";
    },
    {
      code: 6035;
      name: "nothingToRedeem";
      msg: "Nothing to redeem";
    },
    {
      code: 6036;
      name: "mathOverflow";
      msg: "Arithmetic overflow";
    },
  ];
  types: [
    {
      name: "config";
      docs: ['Global program configuration. PDA seeds: `["config"]`.'];
      type: {
        kind: "struct";
        fields: [
          {
            name: "admin";
            docs: ["Admin: config updates, pause, add strike, settlement override (D-026, D-030)."];
            type: "pubkey";
          },
          {
            name: "automationAuthority";
            docs: ["Creates the daily strike markets; can do nothing else (AB-19)."];
            type: "pubkey";
          },
          {
            name: "usdcMint";
            docs: ["Test-USDC mint (6 decimals) used as collateral everywhere."];
            type: "pubkey";
          },
          {
            name: "paused";
            docs: ["Global pause: blocks minting, new orders, `buy_no` and `sell_no` only."];
            type: "bool";
          },
          {
            name: "maxStalenessSlots";
            docs: ["Oracle values older than this many slots are rejected at settlement."];
            type: "u64";
          },
          {
            name: "maxConfBps";
            docs: ["Maximum spread between the two oracle values, in basis points of their mean."];
            type: "u16";
          },
          {
            name: "overrideDelaySecs";
            docs: ["Seconds after `close_ts` before `admin_settle_override` is allowed."];
            type: "u64";
          },
          {
            name: "tickers";
            docs: ["The MAG7 tickers with their feeds; unset slots have an all-zero symbol."];
            type: {
              array: [
                {
                  defined: {
                    name: "ticker";
                  };
                },
                7,
              ];
            };
          },
          {
            name: "bump";
            docs: ["PDA bump."];
            type: "u8";
          },
        ];
      };
    },
    {
      name: "configInitialized";
      type: {
        kind: "struct";
        fields: [
          {
            name: "admin";
            type: "pubkey";
          },
          {
            name: "automationAuthority";
            type: "pubkey";
          },
          {
            name: "usdcMint";
            type: "pubkey";
          },
        ];
      };
    },
    {
      name: "configParams";
      docs: [
        "Every configurable field (everything except `admin` and `paused`), as taken by",
        "`initialize_config` and `update_config`. `usdc_mint` is passed as an account so its decimals",
        "can be checked. Ticker slots not listed keep their value (empty after `initialize_config`);",
        "a full set of seven therefore takes `initialize_config` plus one `update_config`.",
      ];
      type: {
        kind: "struct";
        fields: [
          {
            name: "automationAuthority";
            type: "pubkey";
          },
          {
            name: "maxStalenessSlots";
            type: "u64";
          },
          {
            name: "maxConfBps";
            type: "u16";
          },
          {
            name: "overrideDelaySecs";
            type: "u64";
          },
          {
            name: "tickers";
            type: {
              vec: {
                defined: {
                  name: "tickerSlot";
                };
              };
            };
          },
        ];
      };
    },
    {
      name: "configUpdated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "admin";
            type: "pubkey";
          },
          {
            name: "automationAuthority";
            type: "pubkey";
          },
          {
            name: "usdcMint";
            type: "pubkey";
          },
        ];
      };
    },
    {
      name: "fill";
      type: {
        kind: "struct";
        fields: [
          {
            name: "market";
            type: "pubkey";
          },
          {
            name: "maker";
            type: "pubkey";
          },
          {
            name: "taker";
            type: "pubkey";
          },
          {
            name: "price";
            type: "u8";
          },
          {
            name: "qty";
            type: "u64";
          },
          {
            name: "takerSide";
            type: {
              defined: {
                name: "side";
              };
            };
          },
        ];
      };
    },
    {
      name: "fundsSettled";
      type: {
        kind: "struct";
        fields: [
          {
            name: "market";
            type: "pubkey";
          },
          {
            name: "owner";
            type: "pubkey";
          },
          {
            name: "usdc";
            type: "u64";
          },
          {
            name: "yes";
            type: "u64";
          },
        ];
      };
    },
    {
      name: "marketCreated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "market";
            type: "pubkey";
          },
          {
            name: "ticker";
            type: {
              array: ["u8", 8];
            };
          },
          {
            name: "strikeCents";
            type: "u64";
          },
          {
            name: "tradingDate";
            type: "u32";
          },
          {
            name: "closeTs";
            type: "i64";
          },
          {
            name: "yesMint";
            type: "pubkey";
          },
          {
            name: "noMint";
            type: "pubkey";
          },
        ];
      };
    },
    {
      name: "marketSettled";
      type: {
        kind: "struct";
        fields: [
          {
            name: "market";
            type: "pubkey";
          },
          {
            name: "outcome";
            type: {
              defined: {
                name: "outcome";
              };
            };
          },
          {
            name: "price";
            type: "i128";
          },
          {
            name: "source";
            type: {
              defined: {
                name: "settleSource";
              };
            };
          },
          {
            name: "oracleSlot";
            type: "u64";
          },
        ];
      };
    },
    {
      name: "orderCancelled";
      type: {
        kind: "struct";
        fields: [
          {
            name: "market";
            type: "pubkey";
          },
          {
            name: "owner";
            type: "pubkey";
          },
          {
            name: "orderId";
            type: "u64";
          },
          {
            name: "qty";
            type: "u64";
          },
        ];
      };
    },
    {
      name: "orderKind";
      docs: ["How an order behaves when it does not fill completely."];
      type: {
        kind: "enum";
        variants: [
          {
            name: "limit";
          },
          {
            name: "ioc";
          },
        ];
      };
    },
    {
      name: "orderPlaced";
      type: {
        kind: "struct";
        fields: [
          {
            name: "market";
            type: "pubkey";
          },
          {
            name: "owner";
            type: "pubkey";
          },
          {
            name: "orderId";
            type: "u64";
          },
          {
            name: "side";
            type: {
              defined: {
                name: "side";
              };
            };
          },
          {
            name: "price";
            type: "u8";
          },
          {
            name: "qty";
            type: "u64";
          },
          {
            name: "restedQty";
            type: "u64";
          },
        ];
      };
    },
    {
      name: "outcome";
      docs: ["Binary outcome, written once at settlement and never changed (invariant 4)."];
      type: {
        kind: "enum";
        variants: [
          {
            name: "none";
          },
          {
            name: "yes";
          },
          {
            name: "no";
          },
        ];
      };
    },
    {
      name: "pairsMinted";
      type: {
        kind: "struct";
        fields: [
          {
            name: "market";
            type: "pubkey";
          },
          {
            name: "user";
            type: "pubkey";
          },
          {
            name: "qty";
            type: "u64";
          },
          {
            name: "pairsOutstanding";
            type: "u64";
          },
        ];
      };
    },
    {
      name: "paused";
      type: {
        kind: "struct";
        fields: [
          {
            name: "admin";
            type: "pubkey";
          },
        ];
      };
    },
    {
      name: "redeemed";
      type: {
        kind: "struct";
        fields: [
          {
            name: "market";
            type: "pubkey";
          },
          {
            name: "user";
            type: "pubkey";
          },
          {
            name: "yesQty";
            type: "u64";
          },
          {
            name: "noQty";
            type: "u64";
          },
          {
            name: "usdc";
            type: "u64";
          },
        ];
      };
    },
    {
      name: "settleSource";
      docs: ["Who settled the market."];
      type: {
        kind: "enum";
        variants: [
          {
            name: "none";
          },
          {
            name: "oracle";
          },
          {
            name: "override";
          },
        ];
      };
    },
    {
      name: "side";
      docs: ["Side of the single YES-vs-USDC book."];
      type: {
        kind: "enum";
        variants: [
          {
            name: "bid";
          },
          {
            name: "ask";
          },
        ];
      };
    },
    {
      name: "ticker";
      docs: ["A ticker and its two oracle feeds (one per data source), pinned by feed hash."];
      type: {
        kind: "struct";
        fields: [
          {
            name: "symbol";
            docs: ['Upper-case ASCII symbol, zero-padded (e.g. `b"META\\0\\0\\0\\0"`).'];
            type: {
              array: ["u8", 8];
            };
          },
          {
            name: "feeds";
            docs: ["Switchboard feed accounts, index 0 = Tiingo, index 1 = Twelve Data."];
            type: {
              array: ["pubkey", 2];
            };
          },
          {
            name: "feedHashes";
            docs: ["Feed hashes pinned for the accounts above, same order."];
            type: {
              array: [
                {
                  array: ["u8", 32];
                },
                2,
              ];
            };
          },
        ];
      };
    },
    {
      name: "tickerSlot";
      docs: ["One ticker slot to write: `index` is the position in [`Config::tickers`]."];
      type: {
        kind: "struct";
        fields: [
          {
            name: "index";
            type: "u8";
          },
          {
            name: "ticker";
            type: {
              defined: {
                name: "ticker";
              };
            };
          },
        ];
      };
    },
    {
      name: "unpaused";
      type: {
        kind: "struct";
        fields: [
          {
            name: "admin";
            type: "pubkey";
          },
        ];
      };
    },
  ];
};
