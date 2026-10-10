"use client";

import { useReplay } from "./use-replay";
import {
  demoBadgeText,
  demoBannerLines,
  demoRegistry,
  formatEtDateTime,
  isDemoMarket,
  type DemoRegistry,
} from "@/lib/demo-session";
import type { MarketRow } from "@/lib/markets";
import { replayBannerText, replayInvalidText, type ReplayState } from "@/lib/replay";

/** Leaves replay: the same page with no query string (live data, trading enabled). */
export function exitReplayHref(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

/** The persistent `REPLAY · ... · read-only` bar, or the notice for an unusable replay link. */
export function ReplayBanner({ state }: { readonly state: ReplayState | null }) {
  if (state === null || state.kind === "live") return null;
  if (state.kind === "invalid") {
    return (
      <p
        role="alert"
        data-testid="replay-invalid"
        className="border-b-2 border-mer-loss bg-mer-surface px-mer-4 py-mer-2 text-center text-mer-sm font-semibold text-mer-loss"
      >
        {replayInvalidText(state)}
      </p>
    );
  }
  return (
    <div
      role="status"
      data-testid="replay-banner"
      className="flex flex-wrap items-center justify-center gap-x-mer-4 gap-y-mer-1 bg-mer-ink px-mer-4 py-mer-2 text-center text-mer-sm font-bold tracking-wide text-mer-paper"
    >
      <span>{replayBannerText(state.atSecs)}</span>
      <a href={exitReplayHref()} className="rounded-mer underline underline-offset-4">
        Exit replay
      </a>
    </div>
  );
}

/** One full-width, high-contrast line per open demo session. Real sessions render nothing. */
export function DemoBanner({
  markets,
  nowSecs,
  registry = demoRegistry(),
}: {
  readonly markets: readonly MarketRow[] | null;
  readonly nowSecs: number | null;
  readonly registry?: DemoRegistry;
}) {
  if (markets === null || nowSecs === null) return null;
  const lines = demoBannerLines(markets, registry, nowSecs);
  if (lines.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Demo session"
      data-testid="demo-banner"
      className="bg-mer-warn px-mer-4 py-mer-2 text-center text-mer-sm font-bold tracking-wide text-mer-paper"
    >
      {lines.map((line) => (
        <p key={line.tradingDate}>{line.text}</p>
      ))}
    </div>
  );
}

/**
 * Every page's top banners (sticky, above the header): the demo-session line(s) while a demo
 * market is unsettled, and the replay bar or invalid-link notice on Markets and Trade.
 */
export function SessionBanners({
  markets,
  nowSecs,
}: {
  readonly markets: readonly MarketRow[] | null;
  readonly nowSecs: number | null;
}) {
  const replay = useReplay();
  return (
    <div className="sticky top-0 z-40">
      <ReplayBanner state={replay} />
      <DemoBanner markets={markets} nowSecs={nowSecs} />
    </div>
  );
}

/** The DEMO badge with the simulated date, for a market row or card. Real markets: nothing. */
export function DemoBadge({
  market,
  registry = demoRegistry(),
}: {
  readonly market: Pick<MarketRow, "tradingDate">;
  readonly registry?: DemoRegistry;
}) {
  if (!isDemoMarket(market)) return null;
  return (
    <span
      data-testid="demo-badge"
      className="inline-flex items-center rounded-mer bg-mer-warn px-mer-1 py-0.5 text-mer-xs font-bold text-mer-paper"
    >
      {demoBadgeText(market.tradingDate, registry)}
    </span>
  );
}

/**
 * The Trade page's header line for a demo market: the badge, the simulated date and the
 * on-chain close. Real-session markets render nothing, so their Trade page is unchanged.
 */
export function DemoMarketHeader({
  market,
  registry = demoRegistry(),
}: {
  readonly market: MarketRow;
  readonly registry?: DemoRegistry;
}) {
  if (!isDemoMarket(market)) return null;
  return (
    <p
      data-testid="demo-market-header"
      className="flex flex-wrap items-center gap-mer-2 rounded-mer border-2 border-mer-warn px-mer-3 py-mer-2 text-mer-sm text-mer-ink"
    >
      <DemoBadge market={market} registry={registry} />
      <span>
        Demo market on devnet, no real funds · trading closes {formatEtDateTime(market.closeTs)}{" "}
        (on-chain close)
      </span>
    </p>
  );
}
