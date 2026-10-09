/**
 * Pure view model for the Markets ladder (UI-03). Everything takes injected times and plain
 * values; the components only render what these return. Money and prices are integer cents.
 */
import { complementPriceCents, type BookQuotes } from "@meridian/client";

import { formatUsdCents, scaledToCentsFloor } from "./display";
import {
  CLOSING_SOON_SECS,
  SETTLEMENT_DELAYED_SECS,
  SETTLING_START_SECS,
  type MarketRow,
  type MarketStatus,
} from "./markets";
import { formatCountdown, formatEtHm } from "./time";
import type { StateBadgeProps } from "@/components/ui";

/** A spread wider than this many cents is shown as a bid and ask range, not a midpoint. */
export const WIDE_SPREAD_CENTS = 10;

export type YesView =
  | {
      readonly kind: "mid";
      readonly yes: number;
      /** `100 − yes`, integer cents. */
      readonly no: number;
      /** Implied probability in percent; the same number as the YES price. */
      readonly probability: number;
    }
  | {
      readonly kind: "range";
      readonly bid: number | null;
      readonly ask: number | null;
      /** NO bid = `100 − YES ask`; `null` when the YES ask does not exist. */
      readonly noBid: number | null;
      /** NO ask = `100 − YES bid`; `null` when the YES bid does not exist. */
      readonly noAsk: number | null;
    }
  | { readonly kind: "none" };

/**
 * The displayed-price rule (design.md §3): the book midpoint when both sides exist and the
 * spread is at most 10¢; otherwise the bid and ask range. NO is always derived from YES.
 */
export function yesView(quotes: BookQuotes | null | undefined): YesView {
  if (quotes === null || quotes === undefined) return { kind: "none" };
  const { yesBid: bid, yesAsk: ask, yesMid: mid } = quotes;
  if (bid === null && ask === null) return { kind: "none" };
  if (bid !== null && ask !== null && mid !== null && ask - bid <= WIDE_SPREAD_CENTS) {
    return { kind: "mid", yes: mid, no: complementPriceCents(mid), probability: mid };
  }
  return {
    kind: "range",
    bid,
    ask,
    noBid: ask === null ? null : complementPriceCents(ask),
    noAsk: bid === null ? null : complementPriceCents(bid),
  };
}

/** `55–70¢` or `55¢` (one side) for a range. */
export function rangeText(low: number | null, high: number | null): string {
  if (low !== null && high !== null) return low === high ? `${low}¢` : `${low}–${high}¢`;
  const one = low ?? high;
  return one === null ? "—" : `${one}¢`;
}

export type BadgeContext = {
  readonly nowSecs: number;
  readonly paused: boolean;
  readonly overrideDelaySecs: bigint;
};

/**
 * StateBadge props for a market. `Paused` applies only to a market that would otherwise be Open
 * or Closing soon (design.md §3 "Precedence"); every per-market state wins over it.
 */
export function badgeProps(
  market: MarketRow,
  status: MarketStatus,
  ctx: BadgeContext,
): StateBadgeProps {
  const close = market.closeTs;
  switch (status) {
    case "Open":
      return ctx.paused ? { state: "paused" } : { state: "open" };
    case "ClosingSoon":
      return ctx.paused
        ? { state: "paused" }
        : { state: "closing-soon", remaining: formatCountdown(Number(close) - ctx.nowSecs) };
    case "Closed":
      return { state: "closed", settlingAt: formatEtHm(close + SETTLING_START_SECS) };
    case "Settling":
      return { state: "settling" };
    case "SettlementDelayed": {
      const opensAt = close + ctx.overrideDelaySecs;
      return {
        state: "settlement-delayed",
        overrideAt: BigInt(ctx.nowSecs) >= opensAt ? "now" : formatEtHm(opensAt),
      };
    }
    case "Settled":
      return {
        state: "settled",
        outcome: market.outcome === "No" ? "NO" : "YES",
        price: formatUsdCents(scaledToCentsFloor(market.settlePriceScaled)),
      };
  }
}

export type Transition = { readonly label: string; readonly secondsLeft: number };

/**
 * The countdown to the next state change (D-050). Closing soon is omitted: its badge already
 * counts down to the close. Settled has no next transition.
 */
export function nextTransition(
  market: MarketRow,
  status: MarketStatus,
  nowSecs: number,
  overrideDelaySecs: bigint,
): Transition | null {
  const close = Number(market.closeTs);
  const left = (at: number) => Math.max(0, at - nowSecs);
  switch (status) {
    case "Open":
      return { label: "Closing soon in", secondsLeft: left(close - Number(CLOSING_SOON_SECS)) };
    case "Closed":
      return {
        label: "Settlement starts in",
        secondsLeft: left(close + Number(SETTLING_START_SECS)),
      };
    case "Settling":
      return {
        label: "Settlement delayed in",
        secondsLeft: left(close + Number(SETTLEMENT_DELAYED_SECS)),
      };
    case "SettlementDelayed": {
      const at = close + Number(overrideDelaySecs);
      return nowSecs >= at ? null : { label: "Admin override opens in", secondsLeft: left(at) };
    }
    case "ClosingSoon":
    case "Settled":
      return null;
  }
}

/** The open (creation) and close times of a market in ET: `Opens 09:00 ET · closes 16:00 ET`. */
export function openCloseText(openedAt: number | null, closeTs: bigint): string {
  const opened = openedAt === null ? "Opened —" : `Opened ${formatEtHm(openedAt)} ET`;
  return `${opened} · closes ${formatEtHm(closeTs)} ET`;
}
