/**
 * Pure parts of the devnet rehearsal path of `lifecycle.ts` (M2-12): argument parsing, the
 * persisted state between the `trade` and `redeem` phases, market choice and funding checks.
 * No chain access and no environment here, so everything is unit-tested.
 */
import { parseArgs } from "node:util";

import { z } from "zod";

export const PHASES = ["markets", "trade", "redeem"] as const;
export type Phase = (typeof PHASES)[number];

/** Each trader mints 20 pairs at most and pays for fills: 1,000 USDC covers the scripted intents. */
export const TRADER_USDC_BASE_UNITS = 1_000_000_000n;
/** Rent for three token accounts, the open-orders account and fees for ~15 transactions. */
export const TRADER_MIN_LAMPORTS = 30_000_000n;
/** The trade phase needs this long before close to finish all intents. */
export const MIN_SECS_BEFORE_CLOSE = 180;

export type RehearsalArgs = {
  readonly phase: Phase;
  readonly symbol: string;
  readonly strikeCents: bigint | undefined;
  /** `direct`: fund traders with the FAUCET_KEYPAIR mint authority; `none`: they are funded by hand/faucet. */
  readonly fund: "direct" | "none";
  readonly prevCloses: string | undefined;
  readonly stateDir: string | undefined;
  /** Local validator only: settle with the local oracle, as the M1-10 lifecycle does. */
  readonly localSettle: boolean;
};

/** True when argv asks for the rehearsal path (`--cluster devnet`). */
export function wantsRehearsal(argv: readonly string[]): boolean {
  const at = argv.indexOf("--cluster");
  return at !== -1 && argv[at + 1] === "devnet";
}

export function parseRehearsalArgs(argv: readonly string[]): RehearsalArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      cluster: { type: "string" },
      phase: { type: "string" },
      symbol: { type: "string" },
      "strike-cents": { type: "string" },
      fund: { type: "string" },
      "prev-closes": { type: "string" },
      "state-dir": { type: "string" },
      "local-settle": { type: "boolean" },
    },
    strict: true,
  });
  if (values.cluster !== "devnet") {
    throw new Error('the rehearsal path needs "--cluster devnet"');
  }
  const phase = z
    .enum(PHASES, { error: `--phase must be one of ${PHASES.join(", ")}` })
    .parse(values.phase);
  const fund = z.enum(["direct", "none"]).default("direct").parse(values.fund);
  const strike = values["strike-cents"];
  if (phase === "markets" && values["prev-closes"] === undefined) {
    throw new Error("--phase markets needs --prev-closes <file> (the previous closes JSON)");
  }
  return {
    phase,
    symbol: z
      .string()
      .regex(/^[A-Z]{1,8}$/)
      .default("META")
      .parse(values.symbol),
    strikeCents: strike === undefined ? undefined : BigInt(z.string().regex(/^\d+$/).parse(strike)),
    fund,
    prevCloses: values["prev-closes"],
    stateDir: values["state-dir"],
    localSettle: values["local-settle"] === true,
  };
}

// ---- state between phases ---------------------------------------------------------------------

const baseUnits = z.string().regex(/^-?\d+$/);
export const stateSchema = z.object({
  programId: z.string(),
  market: z.string(),
  symbol: z.string(),
  strikeCents: baseUnits,
  tradingDate: z.number().int(),
  closeTs: z.number().int(),
  traders: z.array(z.object({ name: z.string(), pubkey: z.string() })).length(2),
  /** USDC balance of each trader right before the first intent. */
  startUsdc: z.record(z.string(), baseUnits),
  /** The independent model after the trade phase (cash relative to `startUsdc`). */
  holdings: z.record(z.string(), z.object({ cash: baseUnits, yes: baseUnits, no: baseUnits })),
});
export type RehearsalState = z.infer<typeof stateSchema>;

export function serializeState(state: RehearsalState): string {
  return `${JSON.stringify(stateSchema.parse(state), null, 2)}\n`;
}

export function parseState(text: string): RehearsalState {
  return stateSchema.parse(JSON.parse(text));
}

/** Expected USDC change of one trader once everything is settled and redeemed. */
export function expectedCashChange(
  holding: { cash: string; yes: string; no: string },
  yesWins: boolean,
): bigint {
  return BigInt(holding.cash) + BigInt(yesWins ? holding.yes : holding.no) * 1_000_000n;
}

// ---- market choice ----------------------------------------------------------------------------

export type MarketRow = {
  readonly address: string;
  readonly symbol: string;
  readonly strikeCents: bigint;
  readonly closeTs: number;
  readonly open: boolean;
  readonly pairsOutstanding: bigint;
};

/** The market to trade: open, enough time left, and for the symbol (and strike when given). */
export function pickMarket(
  rows: readonly MarketRow[],
  args: Pick<RehearsalArgs, "symbol" | "strikeCents">,
  nowSecs: number,
): MarketRow {
  const ofSymbol = rows.filter((row) => row.symbol === args.symbol && row.open);
  const tradable = ofSymbol
    .filter((row) => args.strikeCents === undefined || row.strikeCents === args.strikeCents)
    .filter((row) => row.closeTs - nowSecs >= MIN_SECS_BEFORE_CLOSE)
    .sort((x, y) => (x.strikeCents < y.strikeCents ? -1 : x.strikeCents > y.strikeCents ? 1 : 0));
  const [chosen] = tradable;
  if (chosen === undefined) {
    const seen = ofSymbol
      .map((row) => `${row.strikeCents} (closes in ${row.closeTs - nowSecs}s)`)
      .join(", ");
    throw new Error(
      `no open ${args.symbol} market with at least ${MIN_SECS_BEFORE_CLOSE}s before close` +
        `${args.strikeCents === undefined ? "" : ` at strike ${args.strikeCents}`}; ` +
        `open ${args.symbol} markets: ${seen === "" ? "none (is the morning job live? see the runbook fallback)" : seen}`,
    );
  }
  return chosen;
}

/** Throws when a trader is short of what the scripted intents need (the `--fund none` check). */
export function assertFunded(
  name: string,
  balances: { lamports: bigint; usdc: bigint },
  fundedBy: string,
): void {
  const problems: string[] = [];
  if (balances.lamports < TRADER_MIN_LAMPORTS) {
    problems.push(`${balances.lamports} lamports < ${TRADER_MIN_LAMPORTS}`);
  }
  if (balances.usdc < TRADER_USDC_BASE_UNITS) {
    problems.push(`${balances.usdc} USDC base units < ${TRADER_USDC_BASE_UNITS}`);
  }
  if (problems.length > 0) {
    throw new Error(`${name} is not funded (${problems.join("; ")}); ${fundedBy}`);
  }
}

/** Explorer link for a signature (devnet), or the bare signature on a local validator. */
export function explorerUrl(cluster: "devnet" | "localnet", signature: string): string {
  return cluster === "devnet"
    ? `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    : signature;
}
