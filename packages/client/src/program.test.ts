import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { configParamsArg } from "./config";
import {
  createMeridianProgram,
  idlInstructionNames,
  MERIDIAN_IDL,
  MERIDIAN_PROGRAM_ID,
} from "./program";

/** Every instruction in architecture.md § Interfaces, as named in the generated IDL. */
const INTERFACE = [
  "initialize_config",
  "update_config",
  "create_strike_market",
  "add_strike",
  "mint_pair",
  "place_order",
  "cancel_order",
  "settle_funds",
  "buy_no",
  "sell_no",
  "settle_market",
  "admin_settle_override",
  "redeem",
  "pause",
  "unpause",
  "local_oracle_set",
  "version",
];

function offlineProvider(): AnchorProvider {
  // No RPC call is ever made: building instructions is local.
  const connection = new Connection("http://127.0.0.1:1");
  return new AnchorProvider(connection, new Wallet(Keypair.generate()), {});
}

describe("generated client", () => {
  it("carries every instruction of the interface and nothing else", () => {
    expect([...idlInstructionNames()].sort()).toEqual([...INTERFACE].sort());
  });

  it("targets the program ID in the IDL", () => {
    expect(MERIDIAN_PROGRAM_ID.toBase58()).toBe(MERIDIAN_IDL.address);
    expect(MERIDIAN_IDL.metadata.name).toBe("meridian");
  });

  it("builds a typed Program bound to the IDL's address by default", async () => {
    const program = createMeridianProgram(offlineProvider());
    expect(program.programId.equals(MERIDIAN_PROGRAM_ID)).toBe(true);
    const instruction = await program.methods.version().instruction();
    expect(instruction.programId.equals(MERIDIAN_PROGRAM_ID)).toBe(true);
    expect(instruction.keys).toEqual([]);
    const version = MERIDIAN_IDL.instructions.find((ix) => ix.name === "version");
    expect(Array.from(instruction.data)).toEqual(version?.discriminator);
  });

  it("can target another deployment without mutating the shared IDL", () => {
    const other = PublicKey.unique();
    const program = createMeridianProgram(offlineProvider(), other);
    expect(program.programId.equals(other)).toBe(true);
    expect(MERIDIAN_IDL.address).toBe(MERIDIAN_PROGRAM_ID.toBase58());
  });

  it("encodes update_config against the config PDA", async () => {
    const program = createMeridianProgram(offlineProvider());
    const admin = PublicKey.unique();
    const usdcMint = PublicKey.unique();
    const symbols = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META"];
    const params = configParamsArg({
      automationAuthority: PublicKey.unique(),
      maxStalenessSlots: 30n,
      maxConfBps: 5,
      overrideDelaySecs: 3600n,
      tickers: symbols.map((symbol, index) => ({
        index,
        ticker: {
          symbol,
          feeds: [PublicKey.unique(), PublicKey.unique()],
          feedHashes: [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)],
        },
      })),
    });
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      MERIDIAN_PROGRAM_ID,
    );
    // `admin` is a `has_one` relation of `config`; strict accounts avoid fetching it over RPC.
    const instruction = await program.methods
      .updateConfig(params)
      .accountsStrict({ config: configPda, admin, usdcMint })
      .instruction();
    expect(instruction.keys.map((key) => key.pubkey.toBase58())).toEqual(
      [configPda, admin, usdcMint].map((key) => key.toBase58()),
    );
    expect(instruction.keys[1]?.isSigner).toBe(true);
    // 8-byte discriminator + 32 + 8 + 2 + 8 scalars + 4-byte vec length + 6 × (1 + 136) slots.
    expect(instruction.data.length).toBe(8 + 50 + 4 + 6 * 137);
  });
});
