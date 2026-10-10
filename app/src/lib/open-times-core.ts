/**
 * Market open times (P1-4; D-050, OQ-14): the automation service's creation-time index, read
 * through the app's `/api/market-open-times` proxy. One request covers every market, so no page
 * scans signatures per market. Pure schemas and fetch only (safe to import server-side).
 */
import { z } from "zod";

/** The automation service's `GET /markets` body (also what the proxy returns). */
export const openTimesSchema = z.object({
  /** False while the service is still rebuilding its index after a restart. */
  ready: z.boolean(),
  as_of: z.iso.datetime({ offset: true }).nullable(),
  markets: z
    .array(
      z.object({
        market: z.string().min(32).max(44),
        /** Block time of the creation transaction, unix seconds. */
        opened_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        signature: z.string().min(1).max(100),
      }),
    )
    .max(5_000),
});

export type OpenTimesBody = z.infer<typeof openTimesSchema>;

export const OPEN_TIMES_PATH = "/api/market-open-times";
/** Open times never change once known; new markets appear within this. */
export const OPEN_TIMES_REFRESH_MS = 60_000;

/** One market's open time as the UI shows it. */
export type OpenTime =
  /** Unix seconds of the creation transaction. */
  | number
  /** The index answered and has no record of this market: shown as `—`. */
  | null
  /** The index could not be read (or is still rebuilding): "Open time unavailable". */
  | "unavailable";

export type OpenTimes = {
  /** True when the index answered and had finished rebuilding. */
  readonly ready: boolean;
  /** Unix seconds by market address. */
  readonly byMarket: Readonly<Record<string, number>>;
};

/** Reads the proxy; throws plain words (never the response body) on failure. */
export async function fetchOpenTimes(
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
): Promise<OpenTimes> {
  const response = await fetcher(OPEN_TIMES_PATH, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      response.status === 503
        ? "open times are not configured for this app"
        : `open times could not be read (${response.status})`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("open times came back in an unexpected shape");
  }
  const parsed = openTimesSchema.safeParse(body);
  if (!parsed.success) throw new Error("open times came back in an unexpected shape");
  return {
    ready: parsed.data.ready,
    byMarket: Object.fromEntries(parsed.data.markets.map((m) => [m.market, m.opened_at])),
  };
}

/**
 * What to show for `market`: its time when the index has it; `—` (null) when a ready index has no
 * record of it; "unavailable" when the index is still rebuilding, so an absent market is not yet
 * known rather than unknown.
 */
export function openTimeOf(times: OpenTimes, market: string): OpenTime {
  const at = times.byMarket[market];
  if (at !== undefined) return at;
  return times.ready ? null : "unavailable";
}
