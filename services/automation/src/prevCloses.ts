/**
 * Previous official close from two independent sources (FR-13, architecture.md § External
 * integrations): Tiingo and Twelve Data must both answer for the expected date and agree within
 * 5 bps of their mean, else the morning job gets an error and alerts.
 *
 * HTTP is injected so tests run on fixtures only. API keys travel in headers, never in URLs, so
 * URLs and error messages are safe to log.
 */
import { z } from "zod";

import type { IsoDate } from "./calendar";
import { parseDecimalToCents } from "./money";

export type Source = "tiingo" | "twelvedata";

/** The subset of a fetch `Response` this module reads. */
export interface HttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

/** The subset of `fetch` this module calls; production passes `globalThis.fetch`. */
export type HttpGet = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal },
) => Promise<HttpResponse>;

export interface PrevClosesDeps {
  readonly http: HttpGet;
  readonly tiingoApiKey: string;
  readonly twelveDataApiKey: string;
  /** Per-request timeout; defaults to DEFAULT_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

export interface SourceClose {
  readonly source: Source;
  readonly date: IsoDate;
  readonly closeCents: number;
}

export interface PrevClose {
  readonly ticker: string;
  readonly date: IsoDate;
  /** Mean of the two sources' closes, in cents, halves rounded up. */
  readonly closeCents: number;
  readonly spreadBps: number;
  readonly sources: readonly [SourceClose, SourceClose];
}

export type PrevCloseErrorKind =
  "source_unavailable" | "malformed_response" | "missing_bar" | "sources_disagree";

export interface PrevCloseError {
  readonly kind: PrevCloseErrorKind;
  readonly ticker: string;
  readonly date: IsoDate;
  /** The failing source; absent when both answered but disagree. */
  readonly source?: Source;
  readonly message: string;
}

export type PrevCloseResult =
  | { readonly ok: true; readonly value: PrevClose }
  | { readonly ok: false; readonly error: PrevCloseError };

/** Maximum allowed spread between the sources, in bps of their mean (D-007, D-008: 5 bps). */
export const MAX_SPREAD_BPS = 5;
export const DEFAULT_TIMEOUT_MS = 10_000;

const TICKER = /^[A-Z]{1,8}$/;

const tiingoSchema = z.array(
  z.object({ date: z.string(), close: z.union([z.number(), z.string()]) }).loose(),
);

const twelveDataSchema = z.union([
  z
    .object({
      status: z.literal("ok"),
      values: z.array(z.object({ datetime: z.string(), close: z.string() }).loose()),
    })
    .loose(),
  z.object({ status: z.literal("error"), code: z.number(), message: z.string() }).loose(),
]);

/** Fetches `ticker`'s official close for ET date `date` from both sources and checks agreement. */
export async function fetchPrevClose(
  deps: PrevClosesDeps,
  ticker: string,
  date: IsoDate,
): Promise<PrevCloseResult> {
  if (!TICKER.test(ticker)) {
    throw new RangeError(`fetchPrevClose: invalid ticker ${JSON.stringify(ticker)}`);
  }
  const fail = (kind: PrevCloseErrorKind, message: string, source?: Source): PrevCloseResult => ({
    ok: false,
    error: { kind, ticker, date, message, ...(source === undefined ? {} : { source }) },
  });

  const [tiingo, twelve] = await Promise.all([
    fetchTiingo(deps, ticker, date),
    fetchTwelveData(deps, ticker, date),
  ]);
  if (!tiingo.ok) {
    return fail(tiingo.kind, tiingo.message, tiingo.source);
  }
  if (!twelve.ok) {
    return fail(twelve.kind, twelve.message, twelve.source);
  }

  const a = tiingo.value.closeCents;
  const b = twelve.value.closeCents;
  if (!withinSpread(a, b)) {
    return fail(
      "sources_disagree",
      `tiingo ${String(a)}¢ vs twelvedata ${String(b)}¢ differ by more than ${String(MAX_SPREAD_BPS)} bps of their mean`,
    );
  }
  return {
    ok: true,
    value: {
      ticker,
      date,
      closeCents: meanHalfUp(a, b),
      spreadBps: spreadBps(a, b),
      sources: [tiingo.value, twelve.value],
    },
  };
}

/** |a − b| ≤ 5 bps × (a + b) / 2, exactly: |a − b| × 20,000 ≤ 5 × (a + b). */
export function withinSpread(a: number, b: number): boolean {
  const diff = BigInt(Math.abs(a - b));
  return diff * 20_000n <= BigInt(MAX_SPREAD_BPS) * BigInt(a + b);
}

/** Spread in whole bps of the mean, rounded half up (for reporting only). */
function spreadBps(a: number, b: number): number {
  const num = BigInt(Math.abs(a - b)) * 20_000n;
  const den = BigInt(a + b);
  return Number((2n * num + den) / (2n * den));
}

/** (a + b) / 2 rounded half up, for non-negative integers. */
export function meanHalfUp(a: number, b: number): number {
  return Number((BigInt(a) + BigInt(b) + 1n) / 2n);
}

type SourceResult =
  | { readonly ok: true; readonly value: SourceClose }
  | {
      readonly ok: false;
      readonly kind: PrevCloseErrorKind;
      readonly source: Source;
      readonly message: string;
    };

async function fetchTiingo(
  deps: PrevClosesDeps,
  ticker: string,
  date: IsoDate,
): Promise<SourceResult> {
  const source: Source = "tiingo";
  const url =
    `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}/prices` +
    `?startDate=${date}&endDate=${date}`;
  const body = await getJson(deps, source, url, { Authorization: `Token ${deps.tiingoApiKey}` });
  if (!body.ok) {
    return body;
  }
  const parsed = tiingoSchema.safeParse(body.value);
  if (!parsed.success) {
    return malformed(source, parsed.error);
  }
  const bar = parsed.data.find((row) => row.date.slice(0, 10) === date);
  return toSourceClose(source, date, bar?.close);
}

async function fetchTwelveData(
  deps: PrevClosesDeps,
  ticker: string,
  date: IsoDate,
): Promise<SourceResult> {
  const source: Source = "twelvedata";
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}` +
    `&interval=1day&outputsize=5`;
  const body = await getJson(deps, source, url, {
    Authorization: `apikey ${deps.twelveDataApiKey}`,
  });
  if (!body.ok) {
    return body;
  }
  const parsed = twelveDataSchema.safeParse(body.value);
  if (!parsed.success) {
    return malformed(source, parsed.error);
  }
  if (parsed.data.status === "error") {
    return {
      ok: false,
      kind: "source_unavailable",
      source,
      message: `api error ${String(parsed.data.code)}: ${parsed.data.message}`,
    };
  }
  const bar = parsed.data.values.find((row) => row.datetime.slice(0, 10) === date);
  return toSourceClose(source, date, bar?.close);
}

function toSourceClose(
  source: Source,
  date: IsoDate,
  close: number | string | undefined,
): SourceResult {
  if (close === undefined) {
    return { ok: false, kind: "missing_bar", source, message: `no daily bar for ${date}` };
  }
  const closeCents = parseDecimalToCents(String(close));
  if (closeCents === null || closeCents <= 0) {
    return {
      ok: false,
      kind: "malformed_response",
      source,
      message: `close ${JSON.stringify(close)} is not a positive decimal price`,
    };
  }
  return { ok: true, value: { source, date, closeCents } };
}

type JsonResult =
  { readonly ok: true; readonly value: unknown } | Extract<SourceResult, { readonly ok: false }>;

async function getJson(
  deps: PrevClosesDeps,
  source: Source,
  url: string,
  headers: Record<string, string>,
): Promise<JsonResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let text: string;
  try {
    const response = await deps.http(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        kind: "source_unavailable",
        source,
        message: `HTTP ${String(response.status)} from ${url}`,
      };
    }
    text = await response.text();
  } catch (err) {
    return {
      ok: false,
      kind: "source_unavailable",
      source,
      message: `request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return {
      ok: false,
      kind: "malformed_response",
      source,
      message: `response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function malformed(source: Source, error: z.ZodError): SourceResult {
  return {
    ok: false,
    kind: "malformed_response",
    source,
    message: `unexpected response shape: ${z.prettifyError(error)}`,
  };
}
