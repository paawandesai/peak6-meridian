/**
 * Fair values for the app (M3-03, FR-24 display). The shape is the quant service's `GET
 * /fair-values` (architecture.md § Service HTTP contracts); the browser reads it through the
 * server proxy `/api/fair-values`, which keeps the service token off the client. Money is integer
 * cents throughout: edge = market − fair, signed, never a float. No environment is read here, so
 * the module is safe in the client bundle.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

export const fairValueSchema = z.object({
  market: z.string().min(1).max(64),
  ticker: z.string().min(1).max(8),
  strike_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** YES fair value in whole cents, 1 to 99 (domain.md § Fair value). */
  fair_cents: z.number().int().min(1).max(99),
  sigma: z.number().finite().nonnegative(),
  spot: z.union([z.string().regex(/^\d+(\.\d+)?$/), z.number().finite().nonnegative()]),
  as_of: z.iso.datetime({ offset: true }),
  /** The service marks a value stale when its spot is older than 10 s. */
  stale: z.boolean(),
});

export const fairValuesSchema = z.array(fairValueSchema).max(500);

export type FairValue = z.infer<typeof fairValueSchema>;

export const FAIR_VALUES_PATH = "/api/fair-values";
/** Fair values are re-read at least this often while a market is open (M3-03 AC2). */
export const REFRESH_MS = 5_000;
/** A value older than this is shown with a stale label even if the service did not flag it. */
export const STALE_AFTER_SECS = 10;

/** Reads the proxy; throws plain words (never the response body) on failure. */
export async function fetchFairValues(
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
): Promise<FairValue[]> {
  const response = await fetcher(FAIR_VALUES_PATH, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      response.status === 503
        ? "fair values are not configured for this app"
        : `fair values could not be read (${response.status})`,
    );
  }
  const parsed = fairValuesSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("fair values came back in an unexpected shape");
  return parsed.data;
}

/** Edge = market − fair, signed, integer cents. Positive means the market is rich. */
export function edgeCents(marketYesCents: number, fairCents: number): number {
  return marketYesCents - fairCents;
}

export type EdgeWord = "rich" | "cheap" | "fair";

export function edgeWord(edge: number): EdgeWord {
  return edge > 0 ? "rich" : edge < 0 ? "cheap" : "fair";
}

/** `Edge +4¢ (rich)`, `Edge −3¢ (cheap)` (U+2212), `Edge 0¢ (fair)`: the word is always written. */
export function edgeText(edge: number): string {
  const sign = edge > 0 ? "+" : edge < 0 ? "−" : "";
  return `Edge ${sign}${Math.abs(edge)}¢ (${edgeWord(edge)})`;
}

/** A value is stale when the service says so or its `as_of` is older than {@link STALE_AFTER_SECS}. */
export function isStale(value: FairValue, nowSecs: number): boolean {
  if (value.stale) return true;
  return nowSecs - Math.floor(Date.parse(value.as_of) / 1000) > STALE_AFTER_SECS;
}

export type FairValues = {
  readonly status: "loading" | "ready" | "unavailable";
  /** By market address. */
  readonly byMarket: Readonly<Record<string, FairValue>>;
  /** The last refresh failed; the values shown are the last good ones and must read as stale. */
  readonly refreshFailed: boolean;
};

const INITIAL: FairValues = { status: "loading", byMarket: {}, refreshFailed: false };

/**
 * Polls fair values every {@link REFRESH_MS} while `enabled`. A failed poll keeps the last good
 * values and sets `refreshFailed` so they are labelled stale; with nothing ever read the state is
 * `unavailable`, never a made-up number. A tick is skipped while a read is in flight.
 */
export function useFairValues(
  options: {
    readonly enabled?: boolean;
    readonly intervalMs?: number;
    readonly fetcher?: () => Promise<FairValue[]>;
  } = {},
): FairValues {
  const { enabled = true, intervalMs = REFRESH_MS } = options;
  const [state, setState] = useState<FairValues>(INITIAL);
  const fetcherRef = useRef(options.fetcher ?? fetchFairValues);
  fetcherRef.current = options.fetcher ?? fetchFairValues;

  const load = useCallback(async (): Promise<FairValues | "skip"> => {
    try {
      const values = await fetcherRef.current();
      return {
        status: "ready",
        byMarket: Object.fromEntries(values.map((value) => [value.market, value])),
        refreshFailed: false,
      };
    } catch {
      return "skip";
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let inFlight = false;
    const run = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const next = await load();
      inFlight = false;
      if (cancelled) return;
      setState((previous) =>
        next === "skip"
          ? previous.status === "ready"
            ? { ...previous, refreshFailed: true }
            : { status: "unavailable", byMarket: {}, refreshFailed: true }
          : next,
      );
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, intervalMs, load]);

  return state;
}
