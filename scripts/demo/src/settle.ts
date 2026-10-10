/**
 * `make demo-settle`: settles every OPEN market of a demo trading date by
 * `admin_settle_override` at the simulated (AS_OF) session's real close for its ticker.
 *
 * The price comes from the registry (`asOfCloseCentsByTicker`); a missing one is resolved
 * through the closes sources and stored. The program only accepts an override from
 * `close_ts + override_delay_secs`; before that this reports "too early, allowed from <ET>"
 * instead of sending a transaction that would fail with `OverrideTooEarly`.
 */
import { type DemoSessions, findDemoSession, type IsoDate } from "@meridian/client";

import { type CloseResolver } from "./closes";
import { assertDemoTradingDate, formatEt, yyyymmdd } from "./dates";
import { withAsOfCloses } from "./registry";

export interface DemoOpenMarket {
  /** Market PDA, base58. */
  readonly address: string;
  readonly ticker: string;
  readonly strikeCents: bigint;
  /** `close_ts`, unix seconds. */
  readonly closeTs: number;
}

export interface DemoSettleChain {
  /** Config: the admin (base58) and the override delay. */
  config(): Promise<{ readonly admin: string; readonly overrideDelaySecs: number }>;
  /** Open markets whose `trading_date` is `tradingDate` (`YYYYMMDD`). */
  openMarkets(tradingDate: number): Promise<DemoOpenMarket[]>;
  /** Sends `admin_settle_override`; resolves to the signature. Undefined in a DRY_RUN. */
  readonly settle?: ((market: DemoOpenMarket, priceCents: bigint) => Promise<string>) | undefined;
}

export interface DemoSettleInput {
  readonly tradingDate: IsoDate;
  readonly now: Date;
  readonly dryRun: boolean;
  /** The signing admin (base58); must be Config's admin. Absent in a DRY_RUN without a key. */
  readonly admin?: string | undefined;
}

export interface DemoSettleDeps {
  readonly registry: DemoSessions;
  readonly chain: DemoSettleChain;
  readonly closes: CloseResolver;
}

export type SettleStatus = "settled" | "would settle" | "too early" | "no price" | "failed";

export interface DemoSettleRow {
  readonly market: DemoOpenMarket;
  readonly status: SettleStatus;
  readonly priceCents?: number;
  /** YES when price ≥ strike (the program's rule), else NO. */
  readonly outcome?: "YES" | "NO";
  /** First second the program accepts the override. */
  readonly allowedFromTs: number;
  readonly detail: string;
}

export interface DemoSettleReport {
  readonly tradingDate: IsoDate;
  readonly asOf: IsoDate;
  readonly rows: readonly DemoSettleRow[];
  /** The registry with any newly learned AS_OF closes (unchanged in a DRY_RUN). */
  readonly registry: DemoSessions;
  /** True when every open market was settled (or would be, in a DRY_RUN). */
  readonly ok: boolean;
}

/** The outcome the program will record: YES iff the close is at or above the strike. */
export function outcomeFor(priceCents: number, strikeCents: bigint): "YES" | "NO" {
  return BigInt(priceCents) >= strikeCents ? "YES" : "NO";
}

export async function runDemoSettle(
  input: DemoSettleInput,
  deps: DemoSettleDeps,
): Promise<DemoSettleReport> {
  const tradingDate = assertDemoTradingDate(input.tradingDate);
  const session = findDemoSession(deps.registry, tradingDate);
  if (session === undefined) {
    throw new Error(
      `no demo session registered for ${tradingDate} in the registry; run make demo-markets first`,
    );
  }
  const config = await deps.chain.config();
  if (input.admin !== undefined && input.admin !== config.admin) {
    throw new Error(
      `the ADMIN_KEYPAIR_PATH key ${input.admin} is not Config's admin ${config.admin}`,
    );
  }
  const markets = await deps.chain.openMarkets(yyyymmdd(tradingDate));

  // Prices: the registry first, then the closes sources (recorded for next time).
  const prices: Record<string, number> = { ...session.asOfCloseCentsByTicker };
  const learned: Record<string, number> = {};
  const unpriced = new Map<string, string>();
  for (const ticker of [...new Set(markets.map((m) => m.ticker))]) {
    if (prices[ticker] !== undefined) {
      continue;
    }
    const lookup = await deps.closes(ticker, session.asOf);
    if (lookup.ok) {
      prices[ticker] = lookup.cents;
      learned[ticker] = lookup.cents;
    } else {
      unpriced.set(ticker, lookup.reason);
    }
  }

  const nowSecs = Math.floor(input.now.getTime() / 1000);
  const rows: DemoSettleRow[] = [];
  for (const market of markets) {
    rows.push(await settleOne(market, prices[market.ticker], unpriced.get(market.ticker)));
  }

  async function settleOne(
    market: DemoOpenMarket,
    price: number | undefined,
    reason: string | undefined,
  ): Promise<DemoSettleRow> {
    const allowedFromTs = market.closeTs + config.overrideDelaySecs;
    if (price === undefined) {
      return { market, status: "no price", allowedFromTs, detail: reason ?? "no AS_OF close" };
    }
    const priced = { market, priceCents: price, outcome: outcomeFor(price, market.strikeCents) };
    if (nowSecs < allowedFromTs) {
      return {
        ...priced,
        status: "too early",
        allowedFromTs,
        detail: `too early, allowed from ${formatEt(allowedFromTs)}`,
      };
    }
    if (input.dryRun || deps.chain.settle === undefined) {
      return { ...priced, status: "would settle", allowedFromTs, detail: "dry run" };
    }
    try {
      const signature = await deps.chain.settle(market, BigInt(price));
      return { ...priced, status: "settled", allowedFromTs, detail: signature };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...priced, status: "failed", allowedFromTs, detail: message };
    }
  }

  const done: SettleStatus = input.dryRun ? "would settle" : "settled";
  return {
    tradingDate,
    asOf: session.asOf,
    rows,
    registry:
      input.dryRun || Object.keys(learned).length === 0
        ? deps.registry
        : withAsOfCloses(deps.registry, tradingDate, learned),
    ok: rows.every((row) => row.status === done),
  };
}
