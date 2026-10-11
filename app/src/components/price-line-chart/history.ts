/**
 * Pyth price history for the detail view's line chart (docs/redesign-spec.md §4.2): the query to
 * `/api/pyth-history`, the response parse, and the conversion of closes to integer cents. Closes
 * become cents here, at the boundary; nothing after this does arithmetic on dollars.
 */
import { z } from "zod";

import type { BoardTicker } from "@/components/trade-board/types";

export type HistoryRange = "1D" | "1W";

export const HISTORY_RANGES: readonly HistoryRange[] = ["1D", "1W"];

/** Candle size and span per range, and the words used in the chart's caption. */
export const RANGE_SPEC: Readonly<
  Record<
    HistoryRange,
    { readonly resolution: "5" | "60"; readonly spanSecs: number; readonly words: string }
  >
> = {
  "1D": { resolution: "5", spanSecs: 86_400, words: "last day" },
  "1W": { resolution: "60", spanSecs: 604_800, words: "last week" },
};

/** The route caches per 5-minute bucket of `to`, so the client asks for the bucket start. */
export const BUCKET_SECS = 300;

export const HISTORY_PATH = "/api/pyth-history";

export function bucketStart(nowSecs: number): number {
  return Math.floor(nowSecs / BUCKET_SECS) * BUCKET_SECS;
}

export type HistoryQuery = {
  readonly symbol: string;
  readonly resolution: "5" | "60";
  readonly from: number;
  readonly to: number;
};

export function historyQuery(
  ticker: BoardTicker,
  range: HistoryRange,
  nowSecs: number,
): HistoryQuery {
  const { resolution, spanSecs } = RANGE_SPEC[range];
  const to = bucketStart(nowSecs);
  return { symbol: `Equity.US.${ticker}/USD`, resolution, from: to - spanSecs, to };
}

export function historyUrl(query: HistoryQuery): string {
  const params = new URLSearchParams({
    symbol: query.symbol,
    resolution: query.resolution,
    from: String(query.from),
    to: String(query.to),
  });
  return `${HISTORY_PATH}?${params.toString()}`;
}

/** The route's response (same shape as its `PythHistorySchema`, TradingView format). */
export const pythHistorySchema = z.object({
  s: z.enum(["ok", "no_data", "error"]),
  t: z.array(z.number()).optional(),
  o: z.array(z.number()).optional(),
  h: z.array(z.number()).optional(),
  l: z.array(z.number()).optional(),
  c: z.array(z.number()).optional(),
  v: z.array(z.number()).optional(),
});

export type HistoryPoint = {
  /** Candle time, unix seconds. */
  readonly timeSecs: number;
  /** Close in integer cents. */
  readonly closeCents: number;
};

export type ParsedHistory =
  | { readonly kind: "ok"; readonly points: readonly HistoryPoint[] }
  | { readonly kind: "no_data" }
  | { readonly kind: "error" };

/** A close in dollars to integer cents, rounded to the nearest cent. */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * The route's JSON as points ascending by time with closes in cents. `no_data`, missing or empty
 * arrays, or `t` and `c` of different lengths read as no data; anything that fails the schema, and
 * an upstream `error`, read as an error. A repeated time keeps its last close, since the chart
 * needs strictly increasing times.
 */
export function parseHistory(raw: unknown): ParsedHistory {
  const parsed = pythHistorySchema.safeParse(raw);
  if (!parsed.success || parsed.data.s === "error") return { kind: "error" };
  const { s, t, c } = parsed.data;
  if (s !== "ok" || t === undefined || c === undefined) return { kind: "no_data" };
  if (t.length === 0 || t.length !== c.length) return { kind: "no_data" };
  const byTime = new Map<number, number>();
  t.forEach((time, i) => {
    const close = c[i];
    if (close !== undefined) byTime.set(Math.trunc(time), toCents(close));
  });
  const points = [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timeSecs, closeCents]) => ({ timeSecs, closeCents }));
  return { kind: "ok", points };
}
