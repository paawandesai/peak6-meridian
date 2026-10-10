import type { MarketRow } from "@/lib/markets";

/**
 * The Trade page of a market: `/trade/{market address}` (UI-04 AC8). The Markets ladder takes
 * this as its `tradeHref` prop.
 */
export function tradeHref(market: Pick<MarketRow, "address">): string {
  return `/trade/${market.address}`;
}
