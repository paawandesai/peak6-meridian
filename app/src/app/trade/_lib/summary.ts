/**
 * The simulated result of an order and the words around it (NFR-12, NFR-15; design.md §3
 * "Payoff sentence and simulated result"). Everything is derived from the `Fill` events of the
 * simulation, in integer cents; the payoff sentence, the cost strip and the simulation line all
 * read the same {@link Summary}, so their figures cannot disagree. No float is involved.
 */
import {
  BASE_UNITS_PER_CENT,
  type Intent,
  type OrderKindName,
  yesPriceFor,
} from "@meridian/client";

import { isBuy, sideOf } from "./intents";
import { formatPriceTenths, formatUsdCents } from "@/lib/display";
import type { MeridianEvent } from "@/lib/events";
import { formatStrike } from "@/lib/markets";

const CENTS_PER_CONTRACT = 100n;

/** Fills at one price. `price` is in the intent's own terms (NO price for the NO intents). */
export type FillLevel = { readonly price: number; readonly yesPrice: number; readonly qty: bigint };

export type Summary = {
  readonly intent: Intent;
  readonly kind: OrderKindName;
  /** The limit or worst price the user entered, in the intent's own terms. */
  readonly priceCents: number;
  readonly filledQty: bigint;
  /** Limit orders only: the part that rests on the book instead of filling now. */
  readonly restingQty: bigint;
  readonly levels: readonly FillLevel[];
  /** Σ price × qty over the fills, in cents. */
  readonly fillCents: bigint;
  /** Resting quantity at the limit price, in cents. */
  readonly restingCents: bigint;
  /** What the order costs (buys) or pays (sells) if everything fills: fills plus resting. */
  readonly totalCents: bigint;
  /** Contracts the figures are for: filled plus resting. */
  readonly contracts: bigint;
};

/**
 * Folds the simulation's events into a summary. Only fills where `user` is the taker count.
 * `contracts` is 0 when nothing would fill or rest (an empty book for a market order): the
 * caller must not enable signing then.
 */
export function summarize(input: {
  readonly intent: Intent;
  readonly kind: OrderKindName;
  readonly priceCents: number;
  readonly qty: bigint;
  readonly events: readonly MeridianEvent[];
  readonly user: string;
}): Summary {
  const { intent, kind, priceCents, qty } = input;
  const noSide = sideOf(intent) === "NO";
  const levels: FillLevel[] = [];
  let filledQty = 0n;
  let fillCents = 0n;
  for (const event of input.events) {
    if (event.kind !== "Fill" || event.taker !== input.user) continue;
    const price = noSide ? 100 - event.price : event.price;
    filledQty += event.qty;
    fillCents += BigInt(price) * event.qty;
    const known = levels.findIndex((level) => level.yesPrice === event.price);
    const found = known === -1 ? undefined : levels[known];
    if (found === undefined) levels.push({ price, yesPrice: event.price, qty: event.qty });
    else levels[known] = { ...found, qty: found.qty + event.qty };
  }
  const restingQty = kind === "limit" && qty > filledQty ? qty - filledQty : 0n;
  const restingCents = restingQty * BigInt(priceCents);
  return {
    intent,
    kind,
    priceCents,
    filledQty,
    restingQty,
    levels,
    fillCents,
    restingCents,
    totalCents: fillCents + restingCents,
    contracts: filledQty + restingQty,
  };
}

const money = (cents: bigint): string => formatUsdCents(cents);
const plural = (n: bigint, one: string, many: string): string => `${n} ${n === 1n ? one : many}`;

export type MarketFacts = { readonly ticker: string; readonly strikeCents: bigint };

/** `at or above $180` for YES, `below $180` for NO. */
function condition(side: "YES" | "NO", facts: MarketFacts): string {
  const strike = formatStrike(facts.strikeCents);
  return side === "YES" ? `at or above ${strike}` : `below ${strike}`;
}

/** The payoff sentence shown directly above the sign button. */
export function payoffSentence(summary: Summary, facts: MarketFacts): string {
  const side = sideOf(summary.intent);
  const payout = summary.contracts * CENTS_PER_CONTRACT;
  const cond = `if ${facts.ticker} closes ${condition(side, facts)} today`;
  if (isBuy(summary.intent)) {
    const cost = money(summary.totalCents);
    return (
      `You pay ${cost} for ${plural(summary.contracts, "contract", "contracts")}. ` +
      `You win ${money(payout)} (profit ${money(payout - summary.totalCents)}) ${cond}. ` +
      `Max loss ${cost}.`
    );
  }
  return (
    `You receive ${money(summary.totalCents)} for selling ${plural(summary.contracts, side + " contract", side + " contracts")}. ` +
    `You give up ${money(payout)} ${cond}.`
  );
}

export type StripItem = { readonly label: string; readonly value: string };

/** The cost strip: the same figures as the sentence as labelled values (design.md §3, v2). */
export function costStrip(summary: Summary): readonly StripItem[] {
  const payout = summary.contracts * CENTS_PER_CONTRACT;
  const fees: StripItem = { label: "Fees", value: "$0.00" };
  if (isBuy(summary.intent)) {
    return [
      { label: "You pay", value: money(summary.totalCents) },
      { label: "Pays if right", value: money(payout) },
      { label: "Profit if right", value: money(payout - summary.totalCents) },
      fees,
    ];
  }
  return [
    { label: "You receive", value: money(summary.totalCents) },
    { label: "Gives up if right", value: money(payout) },
    fees,
  ];
}

export const FEE_NOTE = "network fee in devnet SOL";

/** The YES book side the fills hit: asks for Buy YES and Sell NO, bids for the others. */
function hitSide(intent: Intent): "ask" | "bid" {
  return intent === "BUY_YES" || intent === "SELL_NO" ? "ask" : "bid";
}

/** The YES side a resting remainder takes: a Buy YES bid, a Sell YES ask, a Buy NO YES ask. */
function restingSide(intent: Intent): "bid" | "ask" {
  return intent === "BUY_YES" ? "bid" : "ask";
}

/** `Simulated: fills 10 at 38¢ NO (62¢ YES bid). 1 signature.` and its variants. */
export function simulationLine(summary: Summary): string {
  const side = sideOf(summary.intent);
  const book = hitSide(summary.intent);
  const parts: string[] = [];
  if (summary.filledQty > 0n) {
    const [first] = summary.levels;
    if (summary.levels.length === 1 && first !== undefined) {
      const yes =
        side === "NO" ? ` (${first.yesPrice}¢ YES ${book === "ask" ? "ask" : "bid"})` : "";
      parts.push(`fills ${summary.filledQty} at ${first.price}¢ ${side}${yes}`);
    } else {
      const average = formatPriceTenths(summary.fillCents * BASE_UNITS_PER_CENT, summary.filledQty);
      const detail = summary.levels.map((level) => `${level.yesPrice}¢ ×${level.qty}`).join(", ");
      parts.push(
        `fills ${summary.filledQty} at an average ${average} ${side} across ${summary.levels.length} prices (YES ${book === "ask" ? "asks" : "bids"} ${detail})`,
      );
    }
  }
  if (summary.restingQty > 0n) {
    const yesPrice = yesPriceFor(summary.intent, summary.priceCents);
    const prefix = summary.filledQty > 0n ? `rests ${summary.restingQty} as` : "rests";
    parts.push(`${prefix} YES ${restingSide(summary.intent)} at ${yesPrice}¢`);
  }
  return `Simulated: ${parts.join("; ")}. 1 signature.`;
}
