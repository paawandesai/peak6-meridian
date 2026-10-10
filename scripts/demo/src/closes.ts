/**
 * Official daily closes for a demo session: the strike basis (the session before AS_OF) and the
 * settle price (AS_OF itself).
 *
 * Sources, in order: a CLOSES_JSON file supplied by the operator (then the data APIs are never
 * called), the local cache, then automation's `prevCloses` (Tiingo + Twelve Data, which must
 * agree). Whatever the APIs return is cached.
 *
 * File shape (CLOSES_JSON and the cache): `{ "AAPL": { "2026-10-08": 340.57993, ... }, ... }`,
 * ticker → ET date → decimal close in dollars, as a JSON number or string. Numbers are read
 * from their source text (never through a binary float) and rounded to integer cents half up.
 */
import { type IsoDate } from "@meridian/client";
import { isoDateSchema, parseDecimalToCents, type PrevCloseResult } from "automation";
import { z } from "zod";

/** Integer cents per ticker per ET date. */
export type ClosesTable = Record<string, Record<IsoDate, number>>;

const TICKER = /^[A-Z]{1,8}$/;

const fileSchema = z.record(
  z.string().regex(TICKER, "expected an upper-case ticker"),
  z.record(isoDateSchema, z.string()),
);

/**
 * Re-writes every bare JSON number as a JSON string holding its exact source text, so decimal
 * closes are parsed as text and never pass through a binary float.
 */
export function quoteJsonNumbers(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text.charAt(i + 1);
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    const number = /^-?\d[\d.eE+-]*/.exec(text.slice(i));
    if (number !== null) {
      out += `"${number[0]}"`;
      i += number[0].length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Parses a closes file; every close must be a positive decimal (no sign, no exponent). */
export function parseClosesJson(text: string, label: string): ClosesTable {
  let raw: unknown;
  try {
    raw = JSON.parse(quoteJsonNumbers(text));
  } catch (error) {
    throw new Error(
      `${label}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${label}: expected { TICKER: { YYYY-MM-DD: close } }: ${z.prettifyError(parsed.error)}`,
    );
  }
  const table: ClosesTable = {};
  for (const [ticker, byDate] of Object.entries(parsed.data)) {
    const row: Record<IsoDate, number> = {};
    for (const [date, decimal] of Object.entries(byDate)) {
      const cents = parseDecimalToCents(decimal);
      if (cents === null || cents <= 0) {
        throw new Error(
          `${label}: ${ticker} ${date} close ${JSON.stringify(decimal)} is not a positive decimal`,
        );
      }
      row[date] = cents;
    }
    table[ticker] = row;
  }
  return table;
}

/** Integer cents as an exact dollar string: 34058 → "340.58". */
export function centsToDecimal(cents: number): string {
  const value = BigInt(cents);
  return `${(value / 100n).toString()}.${(value % 100n).toString().padStart(2, "0")}`;
}

/** The table as a closes file (dollar strings, keys sorted), ending in a newline. */
export function serializeCloses(table: ClosesTable): string {
  const out: Record<string, Record<string, string>> = {};
  for (const ticker of Object.keys(table).sort()) {
    const row = table[ticker] ?? {};
    out[ticker] = Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((date) => [date, centsToDecimal(row[date] ?? 0)]),
    );
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

export type CloseSource = "file" | "cache" | "api";

export type CloseLookup =
  | { readonly ok: true; readonly cents: number; readonly source: CloseSource }
  | { readonly ok: false; readonly reason: string };

export interface CloseResolverDeps {
  /** CLOSES_JSON contents; when present the APIs are never called. */
  readonly file?: ClosesTable | undefined;
  /** The local cache (mutated: fetched closes are added). */
  readonly cache: ClosesTable;
  /** automation's `fetchPrevClose` bound to its deps; absent when the API keys are not set. */
  readonly fetchClose?: ((ticker: string, date: IsoDate) => Promise<PrevCloseResult>) | undefined;
  /** Called after a fetched close is added to the cache (the CLI persists it). */
  readonly onCached?: (() => void) | undefined;
}

export type CloseResolver = (ticker: string, date: IsoDate) => Promise<CloseLookup>;

export function createCloseResolver(deps: CloseResolverDeps): CloseResolver {
  return async (ticker, date) => {
    if (deps.file !== undefined) {
      const fromFile = deps.file[ticker]?.[date];
      if (fromFile !== undefined) {
        return { ok: true, cents: fromFile, source: "file" };
      }
    }
    const cached = deps.cache[ticker]?.[date];
    if (cached !== undefined) {
      return { ok: true, cents: cached, source: "cache" };
    }
    if (deps.file !== undefined) {
      return { ok: false, reason: `no ${ticker} close for ${date} in CLOSES_JSON` };
    }
    if (deps.fetchClose === undefined) {
      return {
        ok: false,
        reason: `no ${ticker} close for ${date}: set CLOSES_JSON, or TIINGO_API_KEY and TWELVEDATA_API_KEY`,
      };
    }
    const fetched = await deps.fetchClose(ticker, date);
    if (!fetched.ok) {
      return {
        ok: false,
        reason: `${ticker} ${date}: ${fetched.error.kind}: ${fetched.error.message}`,
      };
    }
    deps.cache[ticker] = { ...deps.cache[ticker], [date]: fetched.value.closeCents };
    deps.onCached?.();
    return { ok: true, cents: fetched.value.closeCents, source: "api" };
  };
}
