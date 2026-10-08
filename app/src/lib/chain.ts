/** Read-only chain access for the app: markets via `@meridian/client`, test-USDC balance via RPC. */
import { AnchorProvider } from "@coral-xyz/anchor";
import { createMeridianProgram, symbolFromBytes } from "@meridian/client";
import { Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";

import type { PublicConfig } from "./config";
import type { MarketRow } from "./markets";

/** What the UI needs from the chain; components receive it through context so tests can mock it. */
export type MeridianReader = {
  listMarkets(): Promise<MarketRow[]>;
  /** USDC base units held by `owner`; `null` when no USDC mint is configured. */
  usdcBalance(owner: PublicKey): Promise<bigint | null>;
};

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
      };
    }[]
  >;
};

export async function fetchMarkets(accounts: MarketAccountApi): Promise<MarketRow[]> {
  const all = await accounts.all();
  return all.map(({ publicKey, account }) => ({
    address: publicKey.toBase58(),
    ticker: symbolFromBytes(account.ticker),
    tradingDate: account.tradingDate,
    strikeCents: BigInt(account.strikeCents.toString()),
    closeTs: BigInt(account.closeTs.toString()),
    settled: "settled" in account.status,
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
    usdcBalance: (owner) =>
      usdcMint === undefined
        ? Promise.resolve(null)
        : fetchUsdcBalance(connection, owner, usdcMint),
  };
}
