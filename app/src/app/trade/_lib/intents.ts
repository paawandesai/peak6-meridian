/**
 * The four intents as the Trade page shows them (design.md §3 "The four intents"): domain order,
 * labels, outcome sub-labels and the order-form rules. Pure; transactions are built by
 * `@meridian/client`'s `buildTrade`.
 */
import {
  complementCents,
  type Intent,
  MAX_PRICE_CENTS,
  MIN_PRICE_CENTS,
  type OrderKindName,
} from "@meridian/client";

import type { BookLevels } from "./book-view";

/** Domain order: Buy YES · Buy NO · Sell YES · Sell NO. */
export const INTENT_ORDER: readonly Intent[] = ["BUY_YES", "BUY_NO", "SELL_YES", "SELL_NO"];

export const INTENT_LABEL: Record<Intent, string> = {
  BUY_YES: "Buy YES",
  BUY_NO: "Buy NO",
  SELL_YES: "Sell YES",
  SELL_NO: "Sell NO",
};

export function isBuy(intent: Intent): boolean {
  return intent === "BUY_YES" || intent === "BUY_NO";
}

/** The side the intent is on: YES intents and NO intents. */
export function sideOf(intent: Intent): "YES" | "NO" {
  return intent === "BUY_YES" || intent === "SELL_YES" ? "YES" : "NO";
}

/** `$180` style strike for sub-labels, from whole-dollar text the caller formats. */
export function intentSubLabel(intent: Intent, strikeText: string): string {
  switch (intent) {
    case "BUY_YES":
      return `wins if ≥ ${strikeText}`;
    case "BUY_NO":
      return `wins if < ${strikeText}`;
    case "SELL_YES":
      return "exit YES";
    case "SELL_NO":
      return "exit NO";
  }
}

/** Text of the sign button: `Sign and buy NO`. */
export function signLabel(intent: Intent): string {
  const [verb, side] = INTENT_LABEL[intent].split(" ");
  return `Sign and ${verb?.toLowerCase() ?? ""} ${side ?? ""}`;
}

/** SELL_NO is immediate-or-cancel only (`buildTrade` rejects a limit). */
export function allowsLimit(intent: Intent): boolean {
  return intent !== "SELL_NO";
}

/** Default worst price of a market order (domain.md): 99 to buy, 1 to sell, in the intent's terms. */
export function defaultWorstPrice(intent: Intent): number {
  return isBuy(intent) ? MAX_PRICE_CENTS : MIN_PRICE_CENTS;
}

/** Most contracts one order may ask for; a guard against typos, far above any devnet balance. */
export const MAX_ORDER_QTY = 1_000_000n;

export type OrderInput = {
  readonly kind: "limit" | "market";
  readonly priceText: string;
  readonly qtyText: string;
};

export type ParsedOrder =
  | {
      readonly ok: true;
      readonly kind: OrderKindName;
      readonly priceCents: number;
      readonly qty: bigint;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Validates the form text: whole contracts from 1, price in whole cents 1–99. A market order is
 * an IOC at a worst price (the price field then means "worst price"). Nothing is rounded.
 */
export function parseOrder(intent: Intent, input: OrderInput): ParsedOrder {
  const qtyText = input.qtyText.trim();
  if (!/^[0-9]{1,9}$/.test(qtyText) || BigInt(qtyText) < 1n) {
    return { ok: false, message: "Enter a whole number of contracts, at least 1." };
  }
  const qty = BigInt(qtyText);
  if (qty > MAX_ORDER_QTY) {
    return { ok: false, message: `At most ${MAX_ORDER_QTY.toLocaleString("en-US")} contracts.` };
  }
  const priceText = input.priceText.trim();
  if (!/^[0-9]{1,3}$/.test(priceText)) {
    return { ok: false, message: "Enter a price in whole cents, 1 to 99." };
  }
  const priceCents = Number(priceText);
  if (priceCents < MIN_PRICE_CENTS || priceCents > MAX_PRICE_CENTS) {
    return { ok: false, message: "Enter a price in whole cents, 1 to 99." };
  }
  const kind: OrderKindName = input.kind === "limit" && allowsLimit(intent) ? "limit" : "ioc";
  return { ok: true, kind, priceCents, qty };
}

/**
 * The price the form starts with, in the intent's own terms: a market order's worst price, or for
 * a limit the price that crosses the best opposite order (the ask to buy YES, the bid to sell
 * YES, and their complements for NO), falling back to 50¢ on an empty side.
 */
export function startingPrice(
  intent: Intent,
  kind: "limit" | "market",
  levels: BookLevels,
): number {
  if (kind === "market" || !allowsLimit(intent)) return defaultWorstPrice(intent);
  const bestAsk = levels.asks[0]?.price;
  const bestBid = levels.bids[0]?.price;
  switch (intent) {
    case "BUY_YES":
      return bestAsk ?? 50;
    case "SELL_YES":
      return bestBid ?? 50;
    case "BUY_NO":
      return bestBid === undefined ? 50 : complementCents(bestBid);
    case "SELL_NO":
      return bestAsk === undefined ? 50 : complementCents(bestAsk);
  }
}
