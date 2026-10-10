/**
 * Read-only chain access for the Friday tools (M3-09): the cluster guard, a read-only program
 * client, the ET trading date and the day's markets. No key is read and no transaction is sent;
 * the RPC URL, which may carry an API key, never appears in an error.
 */
import { AnchorProvider, type Program } from "@coral-xyz/anchor";
import {
  assertCluster,
  type ClusterName,
  createMeridianProgram,
  type Meridian,
  MERIDIAN_PROGRAM_ID,
  redactRpcUrl,
  symbolFromBytes,
} from "@meridian/client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";

const envSchema = z.object({
  SOLANA_CLUSTER: z.enum(["devnet", "localnet"]),
  SOLANA_RPC_URL: z.string().url(),
  MERIDIAN_PROGRAM_ID: z.string().optional(),
});

export type ReadOnlyChain = {
  readonly cluster: ClusterName;
  readonly connection: Connection;
  readonly program: Program<Meridian>;
  readonly programId: PublicKey;
  /** Replaces the RPC URL in `error`'s message; use for every error leaving the tool. */
  readonly redact: (error: unknown) => Error;
};

/** Parses the environment, then verifies the cluster by genesis hash before anything else. */
export async function connectReadOnly(environment: NodeJS.ProcessEnv): Promise<ReadOnlyChain> {
  const rpcRaw = environment.SOLANA_RPC_URL;
  const redact = (error: unknown): Error => {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(
      rpcRaw === undefined || rpcRaw === "" ? message : redactRpcUrl(message, rpcRaw),
    );
  };
  try {
    const env = envSchema.parse(environment);
    const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
    const cluster = await assertCluster({
      cluster: env.SOLANA_CLUSTER,
      rpcUrl: env.SOLANA_RPC_URL,
      getGenesisHash: () => connection.getGenesisHash(),
    });
    const programId =
      env.MERIDIAN_PROGRAM_ID === undefined
        ? MERIDIAN_PROGRAM_ID
        : new PublicKey(env.MERIDIAN_PROGRAM_ID);
    // A throwaway wallet: it never signs (reads only).
    const provider = new AnchorProvider(
      connection,
      {
        publicKey: Keypair.generate().publicKey,
        signTransaction: () => Promise.reject(new Error("read-only")),
        signAllTransactions: () => Promise.reject(new Error("read-only")),
      },
      { commitment: "confirmed" },
    );
    return {
      cluster,
      connection,
      program: createMeridianProgram(provider, programId),
      programId,
      redact,
    };
  } catch (error) {
    throw redact(error);
  }
}

const etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The ET calendar date of `unixSecs` as the `YYYYMMDD` number stored in `Market.trading_date`. */
export function etTradingDate(unixSecs: number): number {
  const parts = etParts.formatToParts(new Date(unixSecs * 1000));
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return Number(`${pick("year")}${pick("month")}${pick("day")}`);
}

/** `YYYYMMDD` → `YYYY-MM-DD`. */
export function isoDate(tradingDate: number): string {
  const text = String(tradingDate).padStart(8, "0");
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

export type DayMarket = {
  readonly address: PublicKey;
  readonly label: string;
  readonly closeTs: number;
  readonly settled: boolean;
};

/** `META $680` for a strike in cents. */
export function strikeLabel(ticker: string, strikeCents: bigint): string {
  return `${ticker} $${(strikeCents / 100n).toString()}`;
}

/** Every market of `tradingDate` (the chain keeps older days too). */
export async function marketsOfDate(
  program: Program<Meridian>,
  tradingDate: number,
): Promise<DayMarket[]> {
  const all = await program.account.market.all();
  return all
    .filter(({ account }) => account.tradingDate === tradingDate)
    .map(({ publicKey, account }) => ({
      address: publicKey,
      label: strikeLabel(symbolFromBytes(account.ticker), BigInt(account.strikeCents.toString())),
      closeTs: Number(account.closeTs.toString()),
      settled: "settled" in account.status,
    }));
}
