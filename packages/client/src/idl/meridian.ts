/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/meridian.json`.
 */
export type Meridian = {
  address: "H8SBU6m8sGRvKudUGhroDP4oEMyvF9QDhVc9wTFESXSm";
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
          name: "config";
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
          docs: ["The admin; pays for the new accounts."];
          writable: true;
          signer: true;
          relations: ["config"];
        },
        {
          name: "market";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 97, 114, 107, 101, 116];
              },
              {
                kind: "arg";
                path: "ticker";
              },
              {
                kind: "arg";
                path: "tradingDate";
              },
              {
                kind: "arg";
                path: "strikeCents";
              },
            ];
          };
        },
        {
          name: "yesMint";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [121, 101, 115];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "noMint";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [110, 111];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "escrowUsdc";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [101, 115, 99, 114, 111, 119, 95, 117, 115, 100, 99];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "escrowYes";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [101, 115, 99, 114, 111, 119, 95, 121, 101, 115];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "book";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [98, 111, 111, 107];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "usdcMint";
          docs: ["The test-USDC mint pinned in the config."];
          relations: ["config"];
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
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
      docs: ["Admin settlement with a manual price after the delay (FR-09)."];
      discriminator: [92, 131, 189, 52, 161, 70, 203, 95];
      accounts: [
        {
          name: "config";
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
          name: "market";
          writable: true;
        },
        {
          name: "admin";
          docs: ["The admin."];
          signer: true;
          relations: ["config"];
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
          name: "config";
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
          name: "market";
          writable: true;
        },
        {
          name: "book";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [98, 111, 111, 107];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
          relations: ["market"];
        },
        {
          name: "user";
          docs: ["The user buying NO; pays rent for `open_orders` on first use."];
          writable: true;
          signer: true;
        },
        {
          name: "openOrders";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [111, 111];
              },
              {
                kind: "account";
                path: "market";
              },
              {
                kind: "account";
                path: "user";
              },
            ];
          };
        },
        {
          name: "userUsdc";
          writable: true;
        },
        {
          name: "userYes";
          writable: true;
        },
        {
          name: "userNo";
          writable: true;
        },
        {
          name: "yesMint";
          writable: true;
          relations: ["market"];
        },
        {
          name: "noMint";
          writable: true;
          relations: ["market"];
        },
        {
          name: "vault";
          writable: true;
          relations: ["market"];
        },
        {
          name: "escrowUsdc";
          writable: true;
          relations: ["market"];
        },
        {
          name: "escrowYes";
          writable: true;
          relations: ["market"];
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
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
          name: "market";
        },
        {
          name: "book";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [98, 111, 111, 107];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
          relations: ["market"];
        },
        {
          name: "owner";
          docs: ["The order owner."];
          signer: true;
        },
        {
          name: "openOrders";
          docs: [
            "Receives the refund. Its PDA seeds name its stored owner, which must be the signer.",
          ];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [111, 111];
              },
              {
                kind: "account";
                path: "market";
              },
              {
                kind: "account";
                path: "open_orders.owner";
                account: "openOrders";
              },
            ];
          };
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
          name: "config";
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
          name: "automationAuthority";
          docs: ["The automation authority (D-030); pays for the new accounts."];
          writable: true;
          signer: true;
          relations: ["config"];
        },
        {
          name: "market";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 97, 114, 107, 101, 116];
              },
              {
                kind: "arg";
                path: "ticker";
              },
              {
                kind: "arg";
                path: "tradingDate";
              },
              {
                kind: "arg";
                path: "strikeCents";
              },
            ];
          };
        },
        {
          name: "yesMint";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [121, 101, 115];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "noMint";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [110, 111];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "escrowUsdc";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [101, 115, 99, 114, 111, 119, 95, 117, 115, 100, 99];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "escrowYes";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [101, 115, 99, 114, 111, 119, 95, 121, 101, 115];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "book";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [98, 111, 111, 107];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
        },
        {
          name: "usdcMint";
          docs: ["The test-USDC mint pinned in the config."];
          relations: ["config"];
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
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
      docs: ["Test-only oracle writer; never in devnet builds (D-028, AB-22)."];
      discriminator: [91, 149, 169, 250, 188, 137, 130, 242];
      accounts: [
        {
          name: "config";
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
          name: "localFeed";
          writable: true;
        },
        {
          name: "admin";
          docs: ["The admin writes the local oracle (test only)."];
          writable: true;
          signer: true;
          relations: ["config"];
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
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
      name: "migrateConfig";
      docs: [
        "Admin grows the v1 Config account to the current layout in place (M3-10b); optionally",
        "sets the Pyth fields. Fails with `ConfigAlreadyMigrated` on a migrated account.",
      ];
      discriminator: [92, 131, 58, 105, 210, 154, 224, 193];
      accounts: [
        {
          name: "config";
          docs: [
            "The Config PDA, owned by this program. Discriminator, size, bump and admin are checked in",
            "the handler by reading the v1 prefix (a v1 account cannot deserialize as `Config`).",
          ];
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
          docs: ["Must equal the admin stored in the Config; pays the rent top-up."];
          writable: true;
          signer: true;
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "pyth";
          type: {
            option: {
              defined: {
                name: "pythConfigParams";
              };
            };
          };
        },
      ];
    },
    {
      name: "mintPair";
      docs: ["Deposits `qty` USDC and mints `qty` YES + `qty` NO (FR-04). Stub until M1-04."];
      discriminator: [19, 149, 94, 110, 181, 186, 33, 107];
      accounts: [
        {
          name: "config";
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
          name: "market";
          writable: true;
        },
        {
          name: "user";
          docs: ["The user depositing USDC."];
          signer: true;
        },
        {
          name: "userUsdc";
          docs: ["The user's USDC account; the token program checks `user` may debit it."];
          writable: true;
        },
        {
          name: "userYes";
          docs: ["Receives the YES tokens."];
          writable: true;
        },
        {
          name: "userNo";
          docs: ["Receives the NO tokens."];
          writable: true;
        },
        {
          name: "yesMint";
          writable: true;
          relations: ["market"];
        },
        {
          name: "noMint";
          writable: true;
          relations: ["market"];
        },
        {
          name: "vault";
          writable: true;
          relations: ["market"];
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
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
          docs: ["The admin."];
          signer: true;
          relations: ["config"];
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
          name: "config";
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
          name: "market";
        },
        {
          name: "book";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [98, 111, 111, 107];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
          relations: ["market"];
        },
        {
          name: "user";
          docs: ["The order owner; pays rent for `open_orders` on first use."];
          writable: true;
          signer: true;
        },
        {
          name: "openOrders";
          docs: ["The owner's balances in this market, created on first use."];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [111, 111];
              },
              {
                kind: "account";
                path: "market";
              },
              {
                kind: "account";
                path: "user";
              },
            ];
          };
        },
        {
          name: "userUsdc";
          docs: ["USDC source (bids) and destination (ask proceeds)."];
          writable: true;
        },
        {
          name: "userYes";
          docs: ["YES source (asks) and destination (bid fills)."];
          writable: true;
        },
        {
          name: "escrowUsdc";
          writable: true;
          relations: ["market"];
        },
        {
          name: "escrowYes";
          writable: true;
          relations: ["market"];
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
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
      name: "postRedstonePrice";
      docs: ["Permissionless RedStone package verification and price posting (M2-15, D-054)."];
      discriminator: [155, 192, 48, 241, 232, 1, 11, 247];
      accounts: [
        {
          name: "payer";
          docs: ["Payer for the RedstonePrice account if it doesn't exist yet."];
          writable: true;
          signer: true;
        },
        {
          name: "oracleConfig";
          docs: ["OracleConfig PDA (read-only, for signer set and threshold)."];
          pda: {
            seeds: [
              {
                kind: "const";
                value: [111, 114, 97, 99, 108, 101, 95, 99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "market";
          docs: [
            "Market PDA (read-only, for close_ts window validation; AB-03 liveness).",
            "Must match the symbol being posted. Seeds constrained per settle_market pattern.",
          ];
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 97, 114, 107, 101, 116];
              },
              {
                kind: "account";
                path: "market.ticker";
                account: "market";
              },
              {
                kind: "account";
                path: "market.trading_date";
                account: "market";
              },
              {
                kind: "account";
                path: "market.strike_cents";
                account: "market";
              },
            ];
          };
        },
        {
          name: "redstonePrice";
          docs: [
            "RedstonePrice PDA for this ticker (created if it doesn't exist, updated if it does).",
          ];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [114, 101, 100, 115, 116, 111, 110, 101, 95, 112, 114, 105, 99, 101];
              },
              {
                kind: "arg";
                path: "symbol";
              },
            ];
          };
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "symbol";
          type: {
            array: ["u8", 8];
          };
        },
        {
          name: "payload";
          type: "bytes";
        },
      ];
    },
    {
      name: "redeem";
      docs: ["Pair redeem before settlement, winner redeem after (FR-10)."];
      discriminator: [184, 12, 86, 149, 70, 196, 97, 225];
      accounts: [
        {
          name: "market";
          writable: true;
        },
        {
          name: "user";
          docs: ["The user redeeming."];
          signer: true;
        },
        {
          name: "userUsdc";
          docs: ["Receives the USDC."];
          writable: true;
        },
        {
          name: "userYes";
          docs: ["The user's YES account; the token program checks `user` may burn from it."];
          writable: true;
        },
        {
          name: "userNo";
          docs: ["The user's NO account; the token program checks `user` may burn from it."];
          writable: true;
        },
        {
          name: "yesMint";
          writable: true;
          relations: ["market"];
        },
        {
          name: "noMint";
          writable: true;
          relations: ["market"];
        },
        {
          name: "vault";
          writable: true;
          relations: ["market"];
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
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
          name: "config";
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
          name: "market";
          writable: true;
        },
        {
          name: "book";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [98, 111, 111, 107];
              },
              {
                kind: "account";
                path: "market";
              },
            ];
          };
          relations: ["market"];
        },
        {
          name: "user";
          docs: ["The user selling NO; pays rent for `open_orders` on first use."];
          writable: true;
          signer: true;
        },
        {
          name: "openOrders";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [111, 111];
              },
              {
                kind: "account";
                path: "market";
              },
              {
                kind: "account";
                path: "user";
              },
            ];
          };
        },
        {
          name: "userUsdc";
          writable: true;
        },
        {
          name: "userYes";
          writable: true;
        },
        {
          name: "userNo";
          writable: true;
        },
        {
          name: "yesMint";
          writable: true;
          relations: ["market"];
        },
        {
          name: "noMint";
          writable: true;
          relations: ["market"];
        },
        {
          name: "vault";
          writable: true;
          relations: ["market"];
        },
        {
          name: "escrowUsdc";
          writable: true;
          relations: ["market"];
        },
        {
          name: "escrowYes";
          writable: true;
          relations: ["market"];
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
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
      name: "setOracleConfig";
      docs: ["Admin sets RedStone signer set and thresholds (M2-15, D-054)."];
      discriminator: [96, 171, 6, 98, 153, 183, 233, 31];
      accounts: [
        {
          name: "admin";
          docs: ["Admin signer (checked against Config.admin, payer for OracleConfig)."];
          writable: true;
          signer: true;
        },
        {
          name: "config";
          docs: ["Config account (read-only, for admin check)."];
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
          name: "oracleConfig";
          docs: ["OracleConfig PDA (created if it doesn't exist, updated if it does)."];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [111, 114, 97, 99, 108, 101, 95, 99, 111, 110, 102, 105, 103];
              },
            ];
          };
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
              name: "setOracleConfigParams";
            };
          };
        },
      ];
    },
    {
      name: "settleFunds";
      docs: ["Withdraws the owner's free balances (FR-12, D-029). Stub until M1-05."];
      discriminator: [238, 64, 163, 96, 75, 171, 16, 33];
      accounts: [
        {
          name: "market";
        },
        {
          name: "owner";
          docs: ["The open orders owner."];
          signer: true;
        },
        {
          name: "openOrders";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [111, 111];
              },
              {
                kind: "account";
                path: "market";
              },
              {
                kind: "account";
                path: "open_orders.owner";
                account: "openOrders";
              },
            ];
          };
        },
        {
          name: "escrowUsdc";
          writable: true;
          relations: ["market"];
        },
        {
          name: "escrowYes";
          writable: true;
          relations: ["market"];
        },
        {
          name: "userUsdc";
          docs: ["Receives the free USDC."];
          writable: true;
        },
        {
          name: "userYes";
          docs: ["Receives the free YES."];
          writable: true;
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
      ];
      args: [];
    },
    {
      name: "settleMarket";
      docs: [
        "Permissionless settlement from Pyth (primary), RedStone (fallback) or Switchboard (FR-08, M3-10b).",
      ];
      discriminator: [193, 153, 95, 216, 166, 6, 144, 217];
      accounts: [
        {
          name: "config";
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
          name: "market";
          writable: true;
        },
        {
          name: "feedTiingo";
          docs: [
            "Feed for source slot 0 (Tiingo). Owner, address and feed hash are checked against the",
            "config by the oracle adapter. Used for Switchboard path (M2-18 removes).",
          ];
        },
        {
          name: "feedTwelveData";
          docs: [
            "Feed for source slot 1 (Twelve Data). Checked like `feed_tiingo`. Switchboard path.",
          ];
        },
        {
          name: "redstonePrice";
          docs: [
            "RedStone verified price for this ticker (M2-15, D-054). Optional: used as fallback when",
            "Pyth is not present, or for two-source spread check when both Pyth and RedStone are present.",
            "AB-04: PDA seeds constraint ensures this is the price account for market.ticker.",
          ];
          optional: true;
        },
        {
          name: "oracleConfig";
          docs: [
            "Oracle configuration with RedStone signer set. Required when using RedStone path.",
            "AB-04: PDA seeds constraint ensures this is the canonical oracle config.",
          ];
          optional: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [111, 114, 97, 99, 108, 101, 95, 99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "instructionsSysvar";
          docs: [
            "Instructions sysvar (M3-10b, D-055). Required for Pyth Lazer path to validate the",
            "Ed25519Program signature verification instruction.",
          ];
          optional: true;
          address: "Sysvar1nstructions1111111111111111111111111";
        },
        {
          name: "payer";
          docs: ["Anyone: settlement is permissionless (D-030)."];
          signer: true;
        },
      ];
      args: [
        {
          name: "ed25519IxIndex";
          type: {
            option: "u16";
          };
        },
      ];
    },
    {
      name: "unpause";
      docs: ["Lifts the global pause (FR-11). Stub until M1-04."];
      discriminator: [169, 144, 4, 38, 10, 141, 188, 255];
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
          docs: ["The admin."];
          signer: true;
          relations: ["config"];
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
      name: "book";
      discriminator: [121, 34, 121, 35, 91, 62, 85, 222];
    },
    {
      name: "config";
      discriminator: [155, 12, 170, 224, 30, 250, 204, 130];
    },
    {
      name: "localFeed";
      discriminator: [179, 103, 3, 86, 167, 100, 43, 11];
    },
    {
      name: "market";
      discriminator: [219, 190, 213, 55, 0, 227, 198, 154];
    },
    {
      name: "openOrders";
      discriminator: [139, 166, 123, 206, 111, 2, 116, 33];
    },
    {
      name: "oracleConfig";
      discriminator: [133, 196, 152, 50, 27, 21, 145, 254];
    },
    {
      name: "redstonePrice";
      discriminator: [96, 222, 194, 150, 85, 196, 105, 152];
    },
  ];
  events: [
    {
      name: "configInitialized";
      discriminator: [181, 49, 200, 156, 19, 167, 178, 91];
    },
    {
      name: "configMigrated";
      discriminator: [115, 69, 99, 100, 192, 77, 40, 50];
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
      name: "oracleConfigSet";
      discriminator: [248, 155, 240, 40, 76, 69, 13, 4];
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
      name: "redstonePricePosted";
      discriminator: [107, 134, 33, 214, 200, 199, 239, 225];
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
      name: "redStoneMalformedPayload";
      msg: "RedStone payload is malformed or oversized";
    },
    {
      code: 6035;
      name: "redStoneInvalidSignature";
      msg: "RedStone signature verification failed";
    },
    {
      code: 6036;
      name: "redStoneInsufficientSigners";
      msg: "RedStone signer threshold not met";
    },
    {
      code: 6037;
      name: "redStonePackageTooLate";
      msg: "RedStone package timestamp is after close_ts + max_package_delay_secs";
    },
    {
      code: 6038;
      name: "redStonePackageOlderThanStored";
      msg: "RedStone package timestamp is older than the stored value";
    },
    {
      code: 6039;
      name: "redStoneWrongPricePda";
      msg: "RedStone price account is not the expected PDA for this ticker";
    },
    {
      code: 6040;
      name: "redStoneFeedIdMismatch";
      msg: "RedStone feed_id does not match the canonical feed_id for this ticker";
    },
    {
      code: 6041;
      name: "oracleTooManySigners";
      msg: "Too many signers: maximum is 8";
    },
    {
      code: 6042;
      name: "oracleThresholdTooLow";
      msg: "Signer threshold must be at least 1";
    },
    {
      code: 6043;
      name: "oracleThresholdTooHigh";
      msg: "Signer threshold cannot exceed the signer count";
    },
    {
      code: 6044;
      name: "pairQuantityMismatch";
      msg: "Pair redeem needs equal YES and NO quantities before settlement";
    },
    {
      code: 6045;
      name: "nothingToRedeem";
      msg: "Nothing to redeem";
    },
    {
      code: 6046;
      name: "mathOverflow";
      msg: "Arithmetic overflow";
    },
    {
      code: 6047;
      name: "invalidPythMaxAge";
      msg: "pyth_max_age_secs must be greater than zero";
    },
    {
      code: 6048;
      name: "configAlreadyMigrated";
      msg: "Config account is already migrated to the current layout";
    },
    {
      code: 6049;
      name: "configLayoutMismatch";
      msg: "Config account is not a v1 Config (discriminator, size or bump mismatch)";
    },
  ];
  types: [
    {
      name: "book";
      docs: ['The order book of one market. PDA seeds: `["book", market]`.'];
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "bids";
            docs: ["Resting bids; empty slots have `qty == 0`."];
            type: {
              array: [
                {
                  defined: {
                    name: "bookOrder";
                  };
                },
                32,
              ];
            };
          },
          {
            name: "asks";
            docs: ["Resting asks; empty slots have `qty == 0`."];
            type: {
              array: [
                {
                  defined: {
                    name: "bookOrder";
                  };
                },
                32,
              ];
            };
          },
          {
            name: "nextSeq";
            docs: ["Next order id / sequence number."];
            type: "u64";
          },
          {
            name: "market";
            docs: ["The market this book belongs to."];
            type: "pubkey";
          },
          {
            name: "bump";
            docs: ["PDA bump."];
            type: "u8";
          },
          {
            name: "padding";
            docs: ["Keeps the struct free of implicit padding (bytemuck `Pod`)."];
            type: {
              array: ["u8", 7];
            };
          },
        ];
      };
    },
    {
      name: "bookOrder";
      docs: [
        "One resting order. An empty slot has `qty == 0`. Byte-for-byte the layout of",
        "[`meridian_book::Order`] (asserted below), so M1-05 can overlay the engine's book on the",
        "account data without copying.",
      ];
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "orderId";
            docs: ["Unique per market, assigned from `Book::next_seq`."];
            type: "u64";
          },
          {
            name: "owner";
            docs: ["Order owner."];
            type: "pubkey";
          },
          {
            name: "price";
            docs: ["Limit price, cents, 1–99."];
            type: "u8";
          },
          {
            name: "padding";
            docs: [
              "Keeps the struct free of implicit padding (bytemuck `Pod`); mirrors `Order::_pad`.",
            ];
            type: {
              array: ["u8", 7];
            };
          },
          {
            name: "qty";
            docs: ["Remaining contracts."];
            type: "u64";
          },
          {
            name: "seq";
            docs: ["Time priority: lower fills first at the same price."];
            type: "u64";
          },
        ];
      };
    },
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
          {
            name: "pythLazerSigner";
            docs: [
              "Pyth Lazer Ed25519 signer pubkey (D-055, M3-10b). Operator-controlled, never",
              "hard-trusted from payload. Used to verify Pyth signed price updates.",
            ];
            type: "pubkey";
          },
          {
            name: "pythFeedIds";
            docs: [
              "Pyth feed IDs for MAG7 tickers, in the same order as `tickers`. Each u32 is the",
              "numeric Pyth Pro feed ID. Zero means no Pyth feed configured for that ticker slot.",
            ];
            type: {
              array: ["u32", 7];
            };
          },
          {
            name: "pythMaxAgeSecs";
            docs: [
              "Maximum age of Pyth timestamp in seconds (D-055). Pyth timestamps are in microseconds",
              "and checked against clock.unix_timestamp (not slot-based like Core feeds).",
            ];
            type: "i64";
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
      name: "configMigrated";
      docs: ["`migrate_config` grew the v1 Config account to the current layout (M3-10b)."];
      type: {
        kind: "struct";
        fields: [
          {
            name: "admin";
            type: "pubkey";
          },
          {
            name: "oldLen";
            type: "u32";
          },
          {
            name: "newLen";
            type: "u32";
          },
          {
            name: "rentTopUp";
            docs: [
              "Lamports the admin paid to keep the grown account rent-exempt (0 if none were needed).",
            ];
            type: "u64";
          },
          {
            name: "pythSet";
            docs: [
              "True when the Pyth fields were set from the instruction arguments; false leaves them zero.",
            ];
            type: "bool";
          },
          {
            name: "pythLazerSigner";
            type: "pubkey";
          },
          {
            name: "pythMaxAgeSecs";
            type: "i64";
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
          {
            name: "pythLazerSigner";
            type: "pubkey";
          },
          {
            name: "pythFeedIds";
            type: {
              array: ["u32", 7];
            };
          },
          {
            name: "pythMaxAgeSecs";
            type: "i64";
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
      name: "localFeed";
      docs: [
        'Feed written by `local_oracle_set` (D-028). PDA seeds: `["local_feed", symbol, [source_slot]]`.',
        "Exists only in builds with the `local-oracle` feature (AB-22).",
      ];
      type: {
        kind: "struct";
        fields: [
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
            docs: ["Price with 18 fractional digits."];
            type: "i128";
          },
          {
            name: "slot";
            type: "u64";
          },
          {
            name: "updatedAt";
            docs: ["Unix time of the write, from the clock."];
            type: "i64";
          },
          {
            name: "bump";
            type: "u8";
          },
        ];
      };
    },
    {
      name: "market";
      docs: [
        'One strike market. PDA seeds: `["market", symbol, trading_date_le, strike_cents_le]`.',
      ];
      type: {
        kind: "struct";
        fields: [
          {
            name: "ticker";
            docs: ["Ticker symbol, zero-padded, as in [`super::Ticker::symbol`]."];
            type: {
              array: ["u8", 8];
            };
          },
          {
            name: "strikeCents";
            docs: ["Strike in cents ($680 → 68,000); a multiple of [`STRIKE_STEP_CENTS`]."];
            type: "u64";
          },
          {
            name: "tradingDate";
            docs: ["ET calendar date as `YYYYMMDD`."];
            type: "u32";
          },
          {
            name: "closeTs";
            docs: ["Close time, unix seconds (16:00 ET, or 13:00 ET on early-close days)."];
            type: "i64";
          },
          {
            name: "yesMint";
            docs: ["YES mint (0 decimals, authority = this market)."];
            type: "pubkey";
          },
          {
            name: "noMint";
            docs: ["NO mint (0 decimals, authority = this market)."];
            type: "pubkey";
          },
          {
            name: "vault";
            docs: [
              "USDC vault holding pair collateral only: balance = 1,000,000 × `pairs_outstanding`.",
            ];
            type: "pubkey";
          },
          {
            name: "escrowUsdc";
            docs: ["USDC escrow of resting bids."];
            type: "pubkey";
          },
          {
            name: "escrowYes";
            docs: ["YES escrow of resting asks and unsettled maker credits."];
            type: "pubkey";
          },
          {
            name: "book";
            docs: ["Zero-copy order book account."];
            type: "pubkey";
          },
          {
            name: "pairsOutstanding";
            docs: ["Pairs minted and not yet redeemed."];
            type: "u64";
          },
          {
            name: "status";
            docs: ["`Open` or `Settled`."];
            type: {
              defined: {
                name: "marketStatus";
              };
            };
          },
          {
            name: "outcome";
            docs: ["`None` until settled."];
            type: {
              defined: {
                name: "outcome";
              };
            };
          },
          {
            name: "settlePriceScaled";
            docs: ["Settle price with 18 fractional digits (oracle scale); 0 until settled."];
            type: "i128";
          },
          {
            name: "settleSlot";
            docs: ["Oracle slot of the settle price (0 for overrides)."];
            type: "u64";
          },
          {
            name: "settledAt";
            docs: ["Unix timestamp of settlement; 0 until settled."];
            type: "i64";
          },
          {
            name: "settleSource";
            docs: ["`Oracle` or `Override` once settled."];
            type: {
              defined: {
                name: "settleSource";
              };
            };
          },
          {
            name: "bump";
            docs: ["PDA bump; the market signs for its mints and token accounts."];
            type: "u8";
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
      name: "marketStatus";
      docs: [
        'Lifecycle state stored on-chain. "Closed" is derived: `now ≥ close_ts` and not settled.',
      ];
      type: {
        kind: "enum";
        variants: [
          {
            name: "open";
          },
          {
            name: "settled";
          },
        ];
      };
    },
    {
      name: "openOrders";
      docs: ['Free balances of one owner in one market. PDA seeds: `["oo", market, owner]`.'];
      type: {
        kind: "struct";
        fields: [
          {
            name: "owner";
            docs: ["The owner who can withdraw these balances."];
            type: "pubkey";
          },
          {
            name: "market";
            docs: ["The market these balances belong to."];
            type: "pubkey";
          },
          {
            name: "freeUsdc";
            docs: ["USDC base units withdrawable with `settle_funds`."];
            type: "u64";
          },
          {
            name: "freeYes";
            docs: ["YES contracts withdrawable with `settle_funds`."];
            type: "u64";
          },
          {
            name: "restingCount";
            docs: ["Orders currently resting on the book for this owner (cap: 8)."];
            type: "u8";
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
      name: "oracleConfig";
      docs: [
        'Oracle configuration PDA `["oracle_config"]`: pinned RedStone signer set and thresholds.',
        "Separate from `Config` so the live Config account layout is unchanged.",
      ];
      type: {
        kind: "struct";
        fields: [
          {
            name: "signers";
            docs: [
              "Pinned RedStone signer set: Ethereum addresses (20 bytes each), up to 8.",
              "A signer not in this set is ignored; an unknown signer does not cause rejection.",
            ];
            type: {
              vec: {
                array: ["u8", 20];
              };
            };
          },
          {
            name: "signerThreshold";
            docs: [
              "Minimum number of valid signers required for a RedStone package to be accepted (≥ 1, ≤ signers.len()).",
            ];
            type: "u8";
          },
          {
            name: "maxPackageDelaySecs";
            docs: [
              "Maximum age in seconds for a RedStone package timestamp (default 600 s = 10 min).",
              "A package timestamp after `close_ts + max_package_delay_secs` is rejected.",
            ];
            type: "i64";
          },
        ];
      };
    },
    {
      name: "oracleConfigSet";
      type: {
        kind: "struct";
        fields: [
          {
            name: "signerCount";
            type: "u8";
          },
          {
            name: "signerThreshold";
            type: "u8";
          },
          {
            name: "maxPackageDelaySecs";
            type: "i64";
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
      name: "pythConfigParams";
      docs: [
        "The Pyth fields `migrate_config` may set while it grows a v1 account (M3-10b). `None`",
        "leaves them zeroed for a later `update_config`.",
      ];
      type: {
        kind: "struct";
        fields: [
          {
            name: "pythLazerSigner";
            type: "pubkey";
          },
          {
            name: "pythFeedIds";
            type: {
              array: ["u32", 7];
            };
          },
          {
            name: "pythMaxAgeSecs";
            type: "i64";
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
      name: "redstonePrice";
      docs: [
        'RedStone verified price PDA `["redstone_price", symbol]`: stores the most recent verified',
        "RedStone package for a ticker after `post_redstone_price` verifies signatures and threshold.",
      ];
      type: {
        kind: "struct";
        fields: [
          {
            name: "symbol";
            docs: ["Ticker symbol (8 bytes, zero-padded)."];
            type: {
              array: ["u8", 8];
            };
          },
          {
            name: "value";
            docs: ["Price value with 8 decimals (RedStone format, u128 per domain.md)."];
            type: "u128";
          },
          {
            name: "packageTimestampMs";
            docs: ["Package timestamp in milliseconds (RedStone format)."];
            type: "i64";
          },
          {
            name: "postedSlot";
            docs: ["Slot when this price was posted."];
            type: "u64";
          },
          {
            name: "signerCount";
            docs: ["Number of valid signers in the verified package."];
            type: "u8";
          },
        ];
      };
    },
    {
      name: "redstonePricePosted";
      type: {
        kind: "struct";
        fields: [
          {
            name: "symbol";
            type: {
              array: ["u8", 8];
            };
          },
          {
            name: "value";
            type: "u128";
          },
          {
            name: "packageTimestampMs";
            type: "i64";
          },
          {
            name: "postedSlot";
            type: "u64";
          },
          {
            name: "signerCount";
            type: "u8";
          },
        ];
      };
    },
    {
      name: "setOracleConfigParams";
      type: {
        kind: "struct";
        fields: [
          {
            name: "signers";
            docs: ["Pinned RedStone signer set: Ethereum addresses (20 bytes each), up to 8."];
            type: {
              vec: {
                array: ["u8", 20];
              };
            };
          },
          {
            name: "signerThreshold";
            docs: ["Minimum number of valid signers required (≥ 1, ≤ signers.len())."];
            type: "u8";
          },
          {
            name: "maxPackageDelaySecs";
            docs: ["Maximum age in seconds for a RedStone package timestamp (default 600 s)."];
            type: "i64";
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
