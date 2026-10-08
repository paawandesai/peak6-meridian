import { AnchorProvider, type Program, Wallet } from "@coral-xyz/anchor";
import {
  type ConfigParamsInput,
  configParamsArg,
  createMeridianProgram,
  findConfigPda,
  type Meridian,
  symbolFromBytes,
} from "@meridian/client";
import {
  createInitializeMint2Instruction,
  getMinimumBalanceForRentExemptMint,
  getMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  type Connection,
  type Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import type { OnChainConfig } from "./config-plan";

/** Decimals of the test-USDC mint (docs/domain.md § Units). */
export const USDC_DECIMALS = 6;

/** A `Program<Meridian>` signing with `admin` for `programId`. */
export function createProgram(
  connection: Connection,
  admin: Keypair,
  programId: PublicKey,
): Program<Meridian> {
  const provider = new AnchorProvider(connection, new Wallet(admin), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return createMeridianProgram(provider, programId);
}

function toBigInt(value: { toString(): string }): bigint {
  return BigInt(value.toString());
}

/** The Config account decoded, or null when it does not exist. */
export async function readOnChainConfig(program: Program<Meridian>): Promise<OnChainConfig | null> {
  const address = findConfigPda(program.programId).address;
  const account = await program.account.config.fetchNullable(address, "confirmed");
  if (account === null) {
    return null;
  }
  return {
    admin: account.admin,
    automationAuthority: account.automationAuthority,
    usdcMint: account.usdcMint,
    maxStalenessSlots: toBigInt(account.maxStalenessSlots),
    maxConfBps: account.maxConfBps,
    overrideDelaySecs: toBigInt(account.overrideDelaySecs),
    tickers: account.tickers.map((ticker) => {
      const feeds: [PublicKey, PublicKey] = [
        ticker.feeds[0] ?? PublicKey.default,
        ticker.feeds[1] ?? PublicKey.default,
      ];
      const hash = (index: number): Uint8Array => Uint8Array.from(ticker.feedHashes[index] ?? []);
      return {
        symbol: symbolFromBytes(ticker.symbol),
        feeds,
        feedHashes: [hash(0), hash(1)] as [Uint8Array, Uint8Array],
      };
    }),
  };
}

/** Sends `initialize_config` or `update_config` signed by the program's provider (the admin). */
export async function sendConfigStep(
  program: Program<Meridian>,
  kind: "initialize_config" | "update_config",
  params: ConfigParamsInput,
  usdcMint: PublicKey,
  admin: PublicKey,
): Promise<string> {
  const config = findConfigPda(program.programId).address;
  const arg = configParamsArg(params);
  if (kind === "initialize_config") {
    return program.methods
      .initializeConfig(arg)
      .accountsStrict({ config, admin, usdcMint, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
  }
  return program.methods
    .updateConfig(arg)
    .accountsStrict({ config, admin, usdcMint })
    .rpc({ commitment: "confirmed" });
}

/**
 * Verifies on chain that `mint` is an SPL mint with 6 decimals and mint authority `faucet`.
 * Throws a readable error otherwise. Returns false when the account does not exist.
 */
export async function verifyMint(
  connection: Connection,
  mint: PublicKey,
  faucet: PublicKey,
): Promise<boolean> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (info === null) {
    return false;
  }
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`${mint.toBase58()} exists but is not an SPL token mint; refusing to use it`);
  }
  const parsed = await getMint(connection, mint, "confirmed");
  if (parsed.decimals !== USDC_DECIMALS) {
    throw new Error(
      `mint ${mint.toBase58()} has ${parsed.decimals} decimals, expected ${USDC_DECIMALS}; ` +
        "refusing to use it and not creating a second mint over it",
    );
  }
  if (parsed.mintAuthority === null || !parsed.mintAuthority.equals(faucet)) {
    throw new Error(
      `mint ${mint.toBase58()} has mint authority ${parsed.mintAuthority?.toBase58() ?? "none"}, ` +
        `expected FAUCET_PUBKEY ${faucet.toBase58()}; refusing to use it and not creating a second mint`,
    );
  }
  return true;
}

/** Creates the 6-decimal mint at `mint` (a fresh keypair) with mint authority `faucet`. */
export async function createUsdcMint(
  connection: Connection,
  admin: Keypair,
  mint: Keypair,
  faucet: PublicKey,
): Promise<string> {
  const lamports = await getMinimumBalanceForRentExemptMint(connection);
  const transaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint.publicKey, USDC_DECIMALS, faucet, null),
  );
  return sendAndConfirmTransaction(connection, transaction, [admin, mint], {
    commitment: "confirmed",
  });
}
