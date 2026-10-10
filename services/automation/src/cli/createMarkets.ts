/**
 * The morning job's market creation (FR-13): from previous closes, the strike ladder of each
 * ticker, one `create_strike_market` per strike. Idempotent (NFR-05): a market whose PDA
 * already exists is skipped, so running it twice, or after a partial failure, creates no
 * duplicates. Planning is pure; the chain is reached through [`MarketOps`] so tests inject fakes.
 */
import { type Program } from "@coral-xyz/anchor";
import {
  BN,
  findConfigPda,
  marketAddresses,
  type Meridian,
  type MarketKey,
  symbolBytes,
} from "@meridian/client";
import { type PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { closeTimeET, type IsoDate } from "../calendar";
import { computeStrikes } from "../strikes";

/** Ticker order of the config (docs/domain.md § Glossary: MAG7). */
export const TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;

/**
 * P0-1 guard (AC5): refuse --close-in-secs on devnet unless --allow-test-close is set.
 * Exported for unit testing.
 */
export function checkTestMarketGuard(params: {
  readonly hasCloseInSecs: boolean;
  readonly allowTestClose: boolean;
  readonly resolvedCluster: "devnet" | "localnet";
}): void {
  if (
    params.hasCloseInSecs &&
    params.resolvedCluster === "devnet" &&
    !params.allowTestClose
  ) {
    throw new Error(
      "create-markets: --close-in-secs is not allowed on devnet " +
        "without --allow-test-close. Real markets only on the shared devnet deployment; " +
        "test markets use a local validator.",
    );
  }
}

/** `YYYY-MM-DD` naming a real calendar date (so `2026-02-30` and `2026-13-01` are refused). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((text) => {
    const parsed = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text);
  }, "not a real calendar date");

/** Previous closes file: `{ tradingDate, closes: { SYMBOL: cents } }` (tests/fixtures/prev_closes.json). */
export const prevClosesFileSchema = z.object({
  tradingDate: isoDateSchema,
  closes: z.record(z.string().regex(/^[A-Z]{1,8}$/), z.number().int().positive()),
});
export type PrevClosesFile = z.infer<typeof prevClosesFileSchema>;

/** One market to create. */
export interface PlannedMarket {
  readonly key: MarketKey;
  /** `close_ts`, unix seconds. */
  readonly closeTs: number;
}

export interface PlanInput {
  readonly tradingDate: IsoDate;
  /** Previous official close per ticker, integer cents. */
  readonly closes: Readonly<Record<string, number>>;
  /** Overrides the calendar's close (end-to-end runs close a few seconds from now). */
  readonly closeTs?: number;
}

/** `YYYY-MM-DD` as the on-chain `YYYYMMDD`. */
export function tradingDateNumber(date: IsoDate): number {
  return Number(date.replaceAll("-", ""));
}

/** Every market of the day: each configured ticker with a previous close, each of its strikes. */
export function planMarkets(input: PlanInput): PlannedMarket[] {
  // Always consult the calendar: a holiday or weekend is refused even with a close override.
  const calendarCloseTs = closeTimeET(input.tradingDate).closeTs;
  const closeTs = input.closeTs ?? calendarCloseTs;
  const tradingDate = tradingDateNumber(input.tradingDate);
  return TICKERS.filter((symbol) => input.closes[symbol] !== undefined).flatMap((symbol) =>
    computeStrikes(input.closes[symbol] ?? 0).map((strike) => ({
      key: { symbol, tradingDate, strikeCents: BigInt(strike) },
      closeTs,
    })),
  );
}

/** What the chain must offer. */
export interface MarketOps {
  /** True when the market account already exists. */
  exists(planned: PlannedMarket): Promise<boolean>;
  /** Creates the market; resolves to the transaction signature. */
  create(planned: PlannedMarket): Promise<string>;
}

export interface CreateReport {
  readonly created: readonly { readonly planned: PlannedMarket; readonly signature: string }[];
  readonly skipped: readonly PlannedMarket[];
}

/**
 * Creates every planned market that does not exist yet; stops at the first failure.
 * `onCreated` runs right after each creation, so a failure later in the run still leaves the
 * signatures of the markets already created in the caller's log.
 */
export async function createMarkets(
  plan: readonly PlannedMarket[],
  ops: MarketOps,
  onCreated?: (planned: PlannedMarket, signature: string) => void,
): Promise<CreateReport> {
  const created: { planned: PlannedMarket; signature: string }[] = [];
  const skipped: PlannedMarket[] = [];
  for (const planned of plan) {
    if (await ops.exists(planned)) {
      skipped.push(planned);
      continue;
    }
    const signature = await ops.create(planned);
    created.push({ planned, signature });
    onCreated?.(planned, signature);
  }
  return { created, skipped };
}

/** The real chain behind [`MarketOps`]; the program's provider wallet must be the automation authority. */
export async function chainMarketOps(
  program: Program<Meridian>,
  tokenProgram: PublicKey,
  systemProgram: PublicKey,
): Promise<MarketOps> {
  const config = findConfigPda(program.programId).address;
  const configAccount = await program.account.config.fetch(config);
  const connection = program.provider.connection;
  return {
    async exists(planned) {
      const { market } = marketAddresses(planned.key, program.programId);
      return (await connection.getAccountInfo(market, "confirmed")) !== null;
    },
    async create(planned) {
      const a = marketAddresses(planned.key, program.programId);
      return program.methods
        .createStrikeMarket(
          Array.from(symbolBytes(planned.key.symbol)),
          bn(planned.key.strikeCents),
          planned.key.tradingDate,
          bn(BigInt(planned.closeTs)),
        )
        .accountsStrict({
          config,
          automationAuthority: program.provider.publicKey ?? configAccount.automationAuthority,
          market: a.market,
          yesMint: a.yesMint,
          noMint: a.noMint,
          vault: a.vault,
          escrowUsdc: a.escrowUsdc,
          escrowYes: a.escrowYes,
          book: a.book,
          usdcMint: configAccount.usdcMint,
          tokenProgram,
          systemProgram,
        })
        .rpc({ commitment: "confirmed" });
    },
  };
}

function bn(value: bigint): BN {
  // Built from a decimal string so no precision is lost.
  return new BN(value.toString());
}
