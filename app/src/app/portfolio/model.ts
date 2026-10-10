/**
 * Portfolio view model (M2-07): turns the chain snapshot, the book quotes and the markets into
 * the rows, filters, totals and MM block the page renders. Pure: all P&L maths is in `@/lib/pnl`
 * and exact `bigint` base units; nothing is rounded here.
 */
import { BASE_UNITS_PER_USDC } from "@meridian/client";

import type { PortfolioSnapshot, RestingOrder, TokenSlice } from "./data";
import { buildMmBlock, type MmBlockModel } from "./mm";
import type { MarketRow } from "@/lib/markets";
import {
  ifRightPays,
  ledger,
  markTenths,
  type MarketOutcomeName,
  positionKey,
  type Side,
  tradesFromEvents,
  unrealized,
  yesMarkTenths,
  type YesQuotes,
} from "@/lib/pnl";

export type RowState = "open" | "won" | "lost" | "exited";

export type PositionRow = {
  readonly key: string;
  readonly market: MarketRow;
  readonly side: Side;
  /** Contracts held: wallet tokens, free YES in OpenOrders and YES resting in asks. */
  readonly qty: bigint;
  /** Cost of the contracts held and the quantity it is spread over; `null` if history is incomplete. */
  readonly cost: bigint | null;
  /** Mark in tenths of a cent; `null` when no honest mark exists. */
  readonly mark: bigint | null;
  /** qty × $1.00 for an open or unredeemed winning position, else 0. */
  readonly ifRightPays: bigint;
  readonly unrealized: bigint | null;
  readonly realized: bigint | null;
  readonly state: RowState;
  /** Wallet-held tokens of this side (what Redeem can burn right now). */
  readonly walletQty: bigint;
};

export type { MmStrike } from "./mm";

export type PortfolioModel = {
  readonly rows: readonly PositionRow[];
  readonly resting: readonly (RestingOrder & { readonly marketRow: MarketRow })[];
  readonly totals: {
    readonly usdc: bigint | null;
    readonly redeemable: bigint;
    readonly unrealized: bigint;
    readonly realized: bigint;
  };
  readonly mm: MmBlockModel;
  /** Winning wallet tokens to redeem per settled market. */
  readonly redeemable: readonly {
    readonly market: MarketRow;
    readonly yesQty: bigint;
    readonly noQty: bigint;
    readonly yesAccounts: readonly TokenSlice[];
    readonly noAccounts: readonly TokenSlice[];
    readonly usdcAccount: string | null;
    readonly payout: bigint;
  }[];
  /** True when the event history could not account for every contract held. */
  readonly incompleteHistory: boolean;
};

export type PortfolioInput = {
  readonly wallet: string;
  readonly markets: readonly MarketRow[];
  readonly snapshot: PortfolioSnapshot;
  readonly quotes: Readonly<Record<string, YesQuotes | null>>;
  readonly usdcBalance: bigint | null;
};

const EMPTY_HOLDINGS = { yes: 0n, no: 0n, yesAccounts: [], noAccounts: [] };
const SIDES: readonly Side[] = ["YES", "NO"];

export function buildPortfolio(input: PortfolioInput): PortfolioModel {
  const { snapshot, markets } = input;
  const outcomes: Record<string, MarketOutcomeName> = {};
  const settledAt: Record<string, number> = {};
  for (const market of markets) {
    outcomes[market.address] = market.outcome;
    settledAt[market.address] = Number(market.settledAt);
  }
  const extraction = tradesFromEvents(snapshot.events, input.wallet, outcomes, settledAt);
  const positions = ledger(extraction.trades);

  const restingAsks = new Map<string, bigint>();
  for (const order of snapshot.resting) {
    if (order.side === "Ask") {
      restingAsks.set(order.market, (restingAsks.get(order.market) ?? 0n) + order.qty);
    }
  }
  const openOrdersByMarket = new Map(snapshot.openOrders.map((row) => [row.market, row]));

  const rows: PositionRow[] = [];
  let incomplete = snapshot.eventsPartial || extraction.skipped > 0;
  for (const market of markets) {
    const wallet = snapshot.holdings[market.address] ?? EMPTY_HOLDINGS;
    const open = openOrdersByMarket.get(market.address);
    for (const side of SIDES) {
      const walletQty = side === "YES" ? wallet.yes : wallet.no;
      const qty =
        side === "YES"
          ? walletQty + (open?.freeYes ?? 0n) + (restingAsks.get(market.address) ?? 0n)
          : walletQty;
      const position = positions.get(positionKey(market.address, side));
      if (qty === 0n && (position === undefined || position.realized === 0n)) continue;

      const complete =
        (position?.qty ?? 0n) === qty &&
        (position?.shortfall ?? 0n) === 0n &&
        extraction.skipped === 0;
      if (!complete) incomplete = true;
      const yesMark = yesMarkTenths({
        outcome: market.outcome,
        quotes: input.quotes[market.address] ?? null,
        lastYesCents: extraction.lastYesCents[market.address],
      });
      const mark = markTenths(side, yesMark);
      const winning = market.settled && market.outcome === (side === "YES" ? "Yes" : "No");
      const state: RowState =
        qty === 0n ? "exited" : !market.settled ? "open" : winning ? "won" : "lost";
      const cost = complete && position !== undefined ? position.cost : null;
      rows.push({
        key: positionKey(market.address, side),
        market,
        side,
        qty,
        cost,
        mark,
        ifRightPays: state === "open" || state === "won" ? ifRightPays(qty) : 0n,
        unrealized: cost === null || qty === 0n ? null : unrealized(mark, qty, cost),
        realized: complete && position !== undefined ? position.realized : null,
        state,
        walletQty,
      });
    }
  }

  const redeemable = markets.flatMap((market) => {
    if (!market.settled) return [];
    const held = snapshot.holdings[market.address];
    if (held === undefined) return [];
    const winner = market.outcome === "Yes" ? held.yes : market.outcome === "No" ? held.no : 0n;
    return winner > 0n
      ? [
          {
            market,
            yesQty: held.yes,
            noQty: held.no,
            yesAccounts: held.yesAccounts,
            noAccounts: held.noAccounts,
            usdcAccount: snapshot.usdcAccount,
            payout: winner * BASE_UNITS_PER_USDC,
          },
        ]
      : [];
  });

  const byMarket = new Map<string, MarketRow>(markets.map((market) => [market.address, market]));
  const restingRows = snapshot.resting.flatMap((order) => {
    const marketRow = byMarket.get(order.market);
    return marketRow === undefined ? [] : [{ ...order, marketRow }];
  });
  const netByMarket = new Map<string, bigint>();
  for (const row of rows) {
    const signed = row.side === "YES" ? row.qty : -row.qty;
    netByMarket.set(row.market.address, (netByMarket.get(row.market.address) ?? 0n) + signed);
  }
  const mm = buildMmBlock({
    markets,
    openOrders: snapshot.openOrders,
    resting: snapshot.resting,
    netByMarket,
  });

  const sum = (values: Iterable<bigint | null>): bigint => {
    let total = 0n;
    for (const value of values) total += value ?? 0n;
    return total;
  };
  return {
    rows,
    resting: restingRows,
    totals: {
      usdc: input.usdcBalance,
      redeemable: sum(redeemable.map((item) => item.payout)),
      unrealized: sum(rows.map((row) => row.unrealized)),
      realized: sum(rows.map((row) => row.realized)),
    },
    mm,
    redeemable,
    incompleteHistory: incomplete,
  };
}
