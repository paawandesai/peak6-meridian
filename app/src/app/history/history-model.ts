/**
 * View-model for /history (M2-08, UI-06). Pure: turns the typed events from `@/lib/events`
 * (M2-05 owns decoding; nothing here parses logs) into display rows, newest first, with times in
 * ET, plus the market/action filters. The YES book is the only book: Bid is Buy YES, Ask is
 * Sell YES (a Buy NO shows as its Sell YES leg, domain.md § The four intents).
 */
import { formatUsdcBalance } from "@/lib/display";
import type { MeridianEvent } from "@/lib/events";
import { formatStrike, formatTradingDate, type MarketRow } from "@/lib/markets";

export type HistoryAction =
  | "Fill"
  | "Order placed"
  | "Cancel"
  | "Mint"
  | "Redeem"
  | "Withdraw"
  | "Market created"
  | "Market settled";

export const ACTION_BY_KIND: Record<MeridianEvent["kind"], HistoryAction> = {
  Fill: "Fill",
  OrderPlaced: "Order placed",
  OrderCancelled: "Cancel",
  PairsMinted: "Mint",
  Redeemed: "Redeem",
  FundsSettled: "Withdraw",
  MarketCreated: "Market created",
  MarketSettled: "Market settled",
};

export type HistoryRow = {
  readonly id: string;
  readonly signature: string;
  /** `2026-10-08 14:52:07 ET`, or `—` when the cluster reported no block time. */
  readonly timeEt: string;
  readonly blockTime: number | null;
  readonly marketAddress: string;
  /** `AAPL ≥ $230 · 2026-10-08`, or the shortened address when the market is unknown. */
  readonly market: string;
  readonly action: HistoryAction;
  /** `Buy YES`, `Sell YES`, `YES + NO`, `YES`, `NO` or `—`. */
  readonly side: string;
  /** Integer cents, or `null` when the event has no price. */
  readonly priceCents: number | null;
  readonly qty: bigint | null;
  /** Extra facts that do not fit a column (payout, order id, outcome). */
  readonly detail: string;
};

const etFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** `2026-03-08 03:30:00 ET` for unix seconds; the zone (EST/EDT) comes from the platform. */
export function formatEtDateTime(unixSecs: number): string {
  const parts = etFormat.formatToParts(new Date(unixSecs * 1000));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")} ET`;
}

const shorten = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export function marketLabel(address: string, markets: ReadonlyMap<string, MarketRow>): string {
  const row = markets.get(address);
  return row === undefined
    ? shorten(address)
    : `${row.ticker} ≥ ${formatStrike(row.strikeCents)} · ${formatTradingDate(row.tradingDate)}`;
}

/** Whether `event` belongs to `wallet`. Market-level events (created, settled) belong to nobody. */
export function isWalletEvent(event: MeridianEvent, wallet: string): boolean {
  switch (event.kind) {
    case "Fill":
      return event.maker === wallet || event.taker === wallet;
    case "OrderPlaced":
    case "OrderCancelled":
    case "FundsSettled":
      return event.owner === wallet;
    case "PairsMinted":
    case "Redeemed":
      return event.user === wallet;
    default:
      return false;
  }
}

const plural = (n: bigint, word: string) => `${n} ${word}`;

function redeemSide(yesQty: bigint, noQty: bigint): string {
  if (yesQty > 0n && noQty > 0n) return "YES + NO";
  return noQty > 0n ? "NO" : "YES";
}

type Fields = Pick<HistoryRow, "side" | "priceCents" | "qty" | "detail">;

function fields(event: MeridianEvent, wallet: string): Fields {
  switch (event.kind) {
    case "Fill": {
      // The wallet's own side: the taker's, or the opposite when it was the resting maker.
      const taker = event.taker === wallet;
      const bid = taker ? event.takerSide === "Bid" : event.takerSide === "Ask";
      return {
        side: bid ? "Buy YES" : "Sell YES",
        priceCents: event.price,
        qty: event.qty,
        detail: taker ? "Taker" : "Maker",
      };
    }
    case "OrderPlaced":
      return {
        side: event.side === "Bid" ? "Buy YES" : "Sell YES",
        priceCents: event.price,
        qty: event.qty,
        detail: `Order #${event.orderId}, ${plural(event.restedQty, "resting")}`,
      };
    case "OrderCancelled":
      return { side: "—", priceCents: null, qty: event.qty, detail: `Order #${event.orderId}` };
    case "PairsMinted":
      return {
        side: "YES + NO",
        priceCents: null,
        qty: event.qty,
        detail: "Minted at $1.00 a pair",
      };
    case "Redeemed":
      return {
        side: redeemSide(event.yesQty, event.noQty),
        priceCents: null,
        qty: event.yesQty + event.noQty,
        detail: `Paid ${formatUsdcBalance(event.usdc)}`,
      };
    case "FundsSettled":
      return {
        side: "—",
        priceCents: null,
        qty: null,
        detail: `${formatUsdcBalance(event.usdc)} and ${plural(event.yes, "YES")} withdrawn`,
      };
    case "MarketCreated":
      return {
        side: "—",
        priceCents: null,
        qty: null,
        detail: `${event.ticker} strike ${formatStrike(event.strikeCents)}`,
      };
    case "MarketSettled":
      return {
        side: "—",
        priceCents: null,
        qty: null,
        detail: `Settled ${event.outcome.toUpperCase()}`,
      };
  }
}

/** Display rows for `events`, newest first (events without a block time last, log order kept). */
export function buildRows(
  events: readonly MeridianEvent[],
  wallet: string,
  markets: ReadonlyMap<string, MarketRow>,
): HistoryRow[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        (b.event.blockTime ?? -1) - (a.event.blockTime ?? -1) ||
        a.event.signature.localeCompare(b.event.signature) ||
        b.index - a.index,
    )
    .map(({ event, index }) => ({
      id: `${event.signature}:${index}`,
      signature: event.signature,
      blockTime: event.blockTime,
      timeEt: event.blockTime === null ? "—" : formatEtDateTime(event.blockTime),
      marketAddress: event.market,
      market: marketLabel(event.market, markets),
      action: ACTION_BY_KIND[event.kind],
      ...fields(event, wallet),
    }));
}

export const ALL = "all";

/** Filters by market address and action; `ALL` disables a filter. */
export function filterRows(
  rows: readonly HistoryRow[],
  market: string,
  action: string,
): HistoryRow[] {
  return rows.filter(
    (row) =>
      (market === ALL || row.marketAddress === market) && (action === ALL || row.action === action),
  );
}
