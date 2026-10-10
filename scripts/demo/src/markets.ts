/**
 * `make demo-markets`: one demo session's markets on a non-trading day.
 *
 * Strikes are the morning job's own plan for AS_OF (automation's `planMarkets` over the close
 * of the session before AS_OF), re-keyed to the demo trading date and the demo `close_ts`.
 * Creation goes through automation's `createMarkets` (idempotent: an existing PDA is skipped).
 * A planned PDA that already exists with a DIFFERENT `close_ts` aborts the run before anything
 * is created: those markets would not close when the operator asked.
 */
import {
  type DemoSession,
  type DemoSessions,
  findDemoSession,
  type IsoDate,
} from "@meridian/client";
import {
  createMarkets,
  type MarketOps,
  planMarkets,
  type PlannedMarket,
  TICKERS,
} from "automation";

import { type CloseResolver } from "./closes";
import { asOfSession, formatEt, selectDemoTradingDate, yyyymmdd } from "./dates";
import { assertCompatible, upsertSession } from "./registry";

/** A market already on chain. */
export interface ChainMarket {
  readonly ticker: string;
  readonly strikeCents: bigint;
  /** `close_ts`, unix seconds. */
  readonly closeTs: number;
}

/** The chain as demo-markets needs it; absent in an offline DRY_RUN. */
export interface DemoMarketChain {
  /** Every market (open or settled) whose `trading_date` is `tradingDate` (`YYYYMMDD`). */
  marketsOnDate(tradingDate: number): Promise<ChainMarket[]>;
  /** Creation (automation's `chainMarketOps`); undefined in a DRY_RUN. */
  readonly marketOps?: MarketOps | undefined;
}

export interface DemoMarketsInput {
  readonly asOf: IsoDate;
  readonly closeTs: number;
  readonly tradingDate?: IsoDate | undefined;
  readonly tickers: readonly string[];
  readonly dryRun: boolean;
  readonly now: Date;
}

export interface DemoMarketsDeps {
  readonly closes: CloseResolver;
  readonly registry: DemoSessions;
  readonly chain?: DemoMarketChain | undefined;
  readonly onCreated?: (planned: PlannedMarket, signature: string) => void;
}

export type RowStatus =
  | "created"
  | "exists"
  | "would create"
  | "planned (chain not checked)"
  | "NOT created (run stopped)";

export interface DemoMarketRow {
  readonly ticker: string;
  readonly strikeCents: bigint;
  readonly status: RowStatus;
  readonly signature?: string;
}

export interface DemoMarketsReport {
  readonly tradingDate: IsoDate;
  readonly asOf: IsoDate;
  readonly prevDate: IsoDate;
  readonly closeTs: number;
  readonly rows: readonly DemoMarketRow[];
  readonly session: DemoSession;
  /** The registry to write (unchanged in a DRY_RUN). */
  readonly registry: DemoSessions;
  /** Markets already on the trading date that are not part of this session's plan. */
  readonly foreignMarkets: number;
  /** Why creation stopped part-way; the markets created before it are in `rows` and `registry`. */
  readonly error?: string;
}

/** Validates a TICKERS list against the configured MAG7 (default: all, in config order). */
export function parseTickers(text: string | undefined): string[] {
  if (text === undefined || text.trim() === "") {
    return [...TICKERS];
  }
  const wanted = text
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t !== "");
  const unknown = wanted.filter((t) => !(TICKERS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    throw new Error(`TICKERS: unknown ${unknown.join(", ")} (known: ${TICKERS.join(", ")})`);
  }
  return TICKERS.filter((t) => wanted.includes(t));
}

/** The morning job's strikes for AS_OF, re-keyed to the demo date and close. */
export function planDemoMarkets(params: {
  readonly asOf: IsoDate;
  readonly tradingDate: IsoDate;
  readonly closeTs: number;
  readonly prevCloses: Readonly<Record<string, number>>;
}): PlannedMarket[] {
  const demoDate = yyyymmdd(params.tradingDate);
  return planMarkets({
    tradingDate: params.asOf,
    closes: params.prevCloses,
    closeTs: params.closeTs,
  }).map((planned) => ({ ...planned, key: { ...planned.key, tradingDate: demoDate } }));
}

/** Strikes per ticker (integer cents, ascending) of a plan. */
export function strikesByTicker(plan: readonly PlannedMarket[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const { key } of plan) {
    (out[key.symbol] ??= []).push(Number(key.strikeCents));
  }
  for (const strikes of Object.values(out)) {
    strikes.sort((a, b) => a - b);
  }
  return out;
}

const marketKey = (ticker: string, strikeCents: bigint): string =>
  `${ticker}:${strikeCents.toString()}`;

/** `close_ts` of each planned market already on chain, null where its PDA is free. */
function existingCloseTs(
  plan: readonly PlannedMarket[],
  onDate: readonly ChainMarket[],
): (number | null)[] {
  const byKey = new Map(onDate.map((m) => [marketKey(m.ticker, m.strikeCents), m.closeTs]));
  return plan.map((p) => byKey.get(marketKey(p.key.symbol, p.key.strikeCents)) ?? null);
}

/** Existing markets in `plan` whose close differs from `closeTs`, described for the error. */
function conflicts(
  plan: readonly PlannedMarket[],
  existing: readonly (number | null)[],
  closeTs: number,
): string[] {
  return plan.flatMap((planned, i) => {
    const ts = existing[i];
    return ts === null || ts === undefined || ts === closeTs
      ? []
      : [`${planned.key.symbol} ${planned.key.strikeCents.toString()}¢ closes ${formatEt(ts)}`];
  });
}

async function resolveAll(
  closes: CloseResolver,
  tickers: readonly string[],
  date: IsoDate,
): Promise<{ found: Record<string, number>; missing: string[] }> {
  const found: Record<string, number> = {};
  const missing: string[] = [];
  for (const ticker of tickers) {
    const lookup = await closes(ticker, date);
    if (lookup.ok) {
      found[ticker] = lookup.cents;
    } else {
      missing.push(lookup.reason);
    }
  }
  return { found, missing };
}

export async function runDemoMarkets(
  input: DemoMarketsInput,
  deps: DemoMarketsDeps,
): Promise<DemoMarketsReport> {
  const { asOf, prevDate } = asOfSession(input.asOf);
  const prev = await resolveAll(deps.closes, input.tickers, prevDate);
  if (prev.missing.length > 0) {
    throw new Error(
      `strike basis (${prevDate} closes) unavailable:\n  ${prev.missing.join("\n  ")}`,
    );
  }
  // The AS_OF close is the demo-settle price; unknown is fine (it may not have closed yet).
  const asOfCloses = (await resolveAll(deps.closes, input.tickers, asOf)).found;

  const chain = deps.chain;
  const planFor = (tradingDate: IsoDate): PlannedMarket[] =>
    planDemoMarkets({ asOf, tradingDate, closeTs: input.closeTs, prevCloses: prev.found });

  const tradingDate = await selectDemoTradingDate({
    requested: input.tradingDate,
    now: input.now,
    // A default date must be empty on chain, unless it is this very session being re-run.
    isFree: async (date) => {
      try {
        assertCompatible(deps.registry, date, asOf, input.closeTs);
      } catch {
        return false;
      }
      if (chain === undefined || findDemoSession(deps.registry, date) !== undefined) {
        return true;
      }
      return (await chain.marketsOnDate(yyyymmdd(date))).length === 0;
    },
  });
  assertCompatible(deps.registry, tradingDate, asOf, input.closeTs);

  const plan = planFor(tradingDate);
  const onDate = chain === undefined ? [] : await chain.marketsOnDate(yyyymmdd(tradingDate));
  const existing = existingCloseTs(plan, onDate);
  const planned = new Set(plan.map((p) => marketKey(p.key.symbol, p.key.strikeCents)));
  const foreignMarkets = onDate.filter(
    (m) => !planned.has(marketKey(m.ticker, m.strikeCents)),
  ).length;
  const clash = conflicts(plan, existing, input.closeTs);
  if (clash.length > 0) {
    throw new Error(
      `TRADING_DATE ${tradingDate} already has markets at these strikes with another close ` +
        `(nothing was created; pick another TRADING_DATE):\n  ${clash.join("\n  ")}`,
    );
  }

  const missing = plan.filter((_, i) => existing[i] === null);
  const signatures = new Map<PlannedMarket, string>();
  let error: string | undefined;
  if (!input.dryRun) {
    if (chain?.marketOps === undefined) {
      throw new Error("demo-markets: no chain to create markets on (internal: marketOps missing)");
    }
    try {
      await createMarkets(missing, chain.marketOps, (planned, signature) => {
        signatures.set(planned, signature);
        deps.onCreated?.(planned, signature);
      });
    } catch (failure) {
      // Keep what was created: the caller still records the session, then exits non-zero.
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  const rows = plan.map((planned, i): DemoMarketRow => {
    const signature = signatures.get(planned);
    const base = { ticker: planned.key.symbol, strikeCents: planned.key.strikeCents };
    if (signature !== undefined) {
      return { ...base, status: "created", signature };
    }
    if (existing[i] !== null) {
      return { ...base, status: "exists" };
    }
    if (chain === undefined) {
      return { ...base, status: "planned (chain not checked)" };
    }
    if (input.dryRun) {
      return { ...base, status: "would create" };
    }
    return { ...base, status: error === undefined ? "exists" : "NOT created (run stopped)" };
  });

  const session: DemoSession = {
    tradingDate,
    asOf,
    closeTs: input.closeTs,
    createdAt: input.now.toISOString(),
    tickers: Object.keys(prev.found),
    strikesByTicker: strikesByTicker(plan),
    asOfCloseCentsByTicker: asOfCloses,
    prevCloseDate: prevDate,
    prevCloseCentsByTicker: prev.found,
  };
  return {
    tradingDate,
    asOf,
    prevDate,
    closeTs: input.closeTs,
    rows,
    session,
    registry: input.dryRun ? deps.registry : upsertSession(deps.registry, session),
    foreignMarkets,
    ...(error === undefined ? {} : { error }),
  };
}
