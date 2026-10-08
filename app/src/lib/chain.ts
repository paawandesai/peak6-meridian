/** Read-only chain access for the app: markets via `@meridian/client`, test-USDC balance via RPC. */
import { AnchorProvider } from "@coral-xyz/anchor";
import { createMeridianProgram, findConfigPda, symbolFromBytes } from "@meridian/client";
import { Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";

import type { PublicConfig } from "./config";
import type { MarketOutcome, MarketRow } from "./markets";

/** What the UI needs from the chain; components receive it through context so tests can mock it. */
export type MeridianReader = {
  listMarkets(): Promise<MarketRow[]>;
  /** The on-chain `Config` fields the UI reads: the global pause flag and the override delay. */
  getConfig(): Promise<AppConfig>;
  /** USDC base units held by `owner`; `null` when no USDC mint is configured. */
  usdcBalance(owner: PublicKey): Promise<bigint | null>;
};

export type AppConfig = {
  readonly paused: boolean;
  readonly overrideDelaySecs: bigint;
  /** Base58 of `Config.admin`: the only wallet the admin page offers actions to (M2-10). */
  readonly admin: string;
};

/** The slice of the Anchor config account namespace that `getConfig` uses. */
export type ConfigAccountApi = {
  fetch(address: PublicKey): Promise<{
    paused: boolean;
    overrideDelaySecs: { toString(): string };
    admin: PublicKey;
  }>;
};

/** Decodes the `Config` account at `address` (read-only). */
export async function fetchConfig(
  accounts: ConfigAccountApi,
  address: PublicKey,
): Promise<AppConfig> {
  const account = await accounts.fetch(address);
  return {
    paused: account.paused,
    overrideDelaySecs: BigInt(account.overrideDelaySecs.toString()),
    admin: account.admin.toBase58(),
  };
}

/** The slice of the Anchor market account namespace that `listMarkets` uses. */
export type MarketAccountApi = {
  all(): Promise<
    {
      publicKey: PublicKey;
      account: {
        ticker: ArrayLike<number>;
        tradingDate: number;
        strikeCents: { toString(): string };
        closeTs: { toString(): string };
        pairsOutstanding: { toString(): string };
        status: object;
        outcome: object;
        settlePriceScaled: { toString(): string };
      };
    }[]
  >;
};

/** Anchor decodes the `Outcome` enum as `{ none: {} } | { yes: {} } | { no: {} }`. */
function decodeOutcome(outcome: object): MarketOutcome {
  if ("yes" in outcome) return "Yes";
  if ("no" in outcome) return "No";
  return "None";
}

export async function fetchMarkets(accounts: MarketAccountApi): Promise<MarketRow[]> {
  const all = await accounts.all();
  return all.map(({ publicKey, account }) => ({
    address: publicKey.toBase58(),
    ticker: symbolFromBytes(account.ticker),
    tradingDate: account.tradingDate,
    strikeCents: BigInt(account.strikeCents.toString()),
    closeTs: BigInt(account.closeTs.toString()),
    settled: "settled" in account.status,
    outcome: decodeOutcome(account.outcome),
    settlePriceScaled: BigInt(account.settlePriceScaled.toString()),
    pairsOutstanding: BigInt(account.pairsOutstanding.toString()),
  }));
}

const parsedTokenAccounts = z.object({
  value: z.array(
    z.object({
      account: z.object({
        data: z.object({
          parsed: z.object({ info: z.object({ tokenAmount: z.object({ amount: z.string() }) }) }),
        }),
      }),
    }),
  ),
});

/** The slice of `Connection` that `fetchUsdcBalance` uses. */
export type TokenAccountsApi = Pick<Connection, "getParsedTokenAccountsByOwner">;

/** Sum of the owner's token accounts for `mint`, in base units. */
export async function fetchUsdcBalance(
  connection: TokenAccountsApi,
  owner: PublicKey,
  mint: PublicKey,
): Promise<bigint> {
  const response = parsedTokenAccounts.parse(
    await connection.getParsedTokenAccountsByOwner(owner, { mint }),
  );
  return response.value.reduce(
    (sum, entry) => sum + BigInt(entry.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}

const readOnlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("read-only client cannot sign")),
  signAllTransactions: () => Promise.reject(new Error("read-only client cannot sign")),
};

export function createReader(config: PublicConfig): MeridianReader {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" });
  const program = createMeridianProgram(provider, config.programId);
  const { usdcMint } = config;
  return {
    listMarkets: () => fetchMarkets(program.account.market),
    getConfig: () => fetchConfig(program.account.config, findConfigPda(config.programId).address),
    usdcBalance: (owner) =>
      usdcMint === undefined
        ? Promise.resolve(null)
        : fetchUsdcBalance(connection, owner, usdcMint),
  };
}
