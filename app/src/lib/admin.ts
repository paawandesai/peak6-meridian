/**
 * Admin page rules (M2-10, UI-08): validation of the add-strike form and the pause texts.
 * Pure: the clock is injected. The program re-checks everything (AB-06); this only gives clear
 * messages before the admin is asked to sign.
 */
import { dollarsToStrikeCents, isValidStrikeCents } from "@meridian/client";

import type { MarketRow } from "./markets";
import { etTradingDate, formatEtHm } from "./time";

/** The seven MAG7 tickers (docs/domain.md). */
export const TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;

export type AddStrikeParams = {
  readonly ticker: string;
  readonly strikeCents: bigint;
  readonly tradingDate: number;
  readonly closeTs: bigint;
};

export type AddStrikeCheck =
  | { readonly ok: true; readonly params: AddStrikeParams }
  | { readonly ok: false; readonly message: string };

const fail = (message: string): AddStrikeCheck => ({ ok: false, message });

/**
 * Validates the form for TODAY (ET). The close time is the one of today's existing markets
 * (it already reflects early-close days), so the admin never types a time.
 */
export function validateAddStrike(input: {
  readonly ticker: string;
  readonly strikeText: string;
  readonly markets: readonly MarketRow[];
  readonly nowSecs: number;
}): AddStrikeCheck {
  const { ticker, strikeText, markets, nowSecs } = input;
  if (!(TICKERS as readonly string[]).includes(ticker)) {
    return fail("Choose one of the seven tickers.");
  }
  const text = strikeText.trim().replace(/^\$/, "");
  if (!/^[0-9]{1,7}$/.test(text)) {
    return fail("Enter the strike in whole dollars, a multiple of $10 (for example 680).");
  }
  const strikeCents = dollarsToStrikeCents(BigInt(text));
  if (!isValidStrikeCents(strikeCents)) {
    return fail("Strike must be a positive multiple of $10 (for example 680).");
  }
  const tradingDate = etTradingDate(nowSecs);
  const today = markets.filter((market) => market.tradingDate === tradingDate);
  const closeTs = today[0]?.closeTs;
  if (closeTs === undefined) {
    return fail(
      "There are no markets for today yet, so the close time is unknown. Add a strike after the morning job has created today's markets.",
    );
  }
  if (closeTs <= BigInt(nowSecs)) {
    return fail(
      `Today's markets closed at ${formatEtHm(closeTs)} ET. A strike cannot be added after the close.`,
    );
  }
  if (today.some((market) => market.ticker === ticker && market.strikeCents === strikeCents)) {
    return fail(`${ticker} $${text} already exists for today. Choose a different strike.`);
  }
  return { ok: true, params: { ticker, strikeCents, tradingDate, closeTs } };
}

/** What a pause stops and what keeps working (design.md §3 "Not tradable"; domain.md). */
export const PAUSE_STOPS =
  "Mint pair, new orders, Buy NO and Sell NO are stopped for every market.";
export const PAUSE_KEEPS =
  "Cancel, withdraw (settle funds), redeem and automatic settlement keep working.";
export const UNPAUSE_RESUMES =
  "Unpausing lets traders mint, place orders, buy NO and sell NO again.";

/** Text for a failed admin transaction: the program's message when it has one. */
export function adminErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "" ? "unknown error" : message;
}
