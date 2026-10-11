"use client";

import { type KeyboardEvent, useEffect, useRef } from "react";

import { resolveSelectedStrike } from "./default-strike";
import { StrikeSelector } from "./strike-selector";
import type { DetailViewProps } from "./types";
import { DistributionChart } from "../distribution-chart/distribution-chart";
import {
  distributionPoints,
  displayedYes,
  fairStaleness,
} from "../distribution-chart/distribution";
import { emptyDistributionText } from "../distribution-chart/distribution-section";
import { FairEdge } from "../fair-value/fair-edge";
import { closeSets, soonestOpenClose } from "../markets/ticker-ladder";
import { PriceLineChart } from "../price-line-chart/price-line-chart";
import { PythPrice, PythPricePlaceholder } from "../pyth-price";
import { formatStrike } from "@/lib/markets";
import { formatEtHm } from "@/lib/time";

/**
 * The selected stock above the board (docs/redesign-spec.md §2.3): its live price and close, a
 * strike selector with that strike's fair value, edge and a link to trade it, the implied
 * distribution and the price line. Purely presentational: every value comes from props. Opening
 * it moves focus to its heading; Close and Esc call `onClose` (the board returns focus to the tile).
 */
export function DetailView({
  tile,
  selectedMarket,
  fair,
  ctx,
  onSelectMarket,
  onClose,
  tradeHref,
}: DetailViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [tile.ticker]);

  const { ticker, pythQuote } = tile;
  const live = pythQuote === undefined ? null : BigInt(pythQuote.price_cents);
  const ladder = closeSets(
    tile.open.map((cell) => cell.market),
    live,
  ).primary;
  const selected = resolveSelectedStrike(ladder, selectedMarket, live);
  const cell = tile.open.find((c) => c.market.address === selected?.address);
  const quotes = Object.fromEntries(tile.open.map((c) => [c.market.address, c.quotes]));
  const fairByAddress = Object.fromEntries(
    Object.entries(fair.byMarket).map(([address, value]) => [address, value.fair_cents]),
  );
  const points = distributionPoints(
    ladder,
    quotes,
    fairByAddress,
    fairStaleness(fair.byMarket, fair.lastSuccessSecs, ctx.nowSecs),
  );
  const priced = points.some((point) => point.yesCents !== null);
  const headingId = `detail-heading-${ticker}`;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      className="grid min-w-0 gap-mer-4 rounded-mer border border-mer-rule bg-mer-surface p-mer-4"
      data-testid="detail-view"
    >
      <div className="flex flex-wrap items-baseline gap-x-mer-4 gap-y-mer-1">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-mer-xl font-semibold">
          {ticker}
        </h2>
        {pythQuote === undefined ? (
          <PythPricePlaceholder />
        ) : (
          <PythPrice quote={pythQuote} nowMs={ctx.nowSecs * 1000} />
        )}
        {ladder.length > 0 ? (
          <span className="text-mer-sm text-mer-ink-muted">
            closes {formatEtHm(soonestOpenClose(ladder, ctx.nowSecs))} ET
          </span>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto min-h-9 rounded-mer border border-mer-control-border px-mer-3 text-mer-sm"
        >
          Close
        </button>
      </div>

      {selected === null ? (
        <p className="text-mer-sm text-mer-ink-muted">No open markets for {ticker} right now.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-x-mer-6 gap-y-mer-3">
          <StrikeSelector
            ticker={ticker}
            strikes={ladder}
            selected={selected.address}
            onSelect={onSelectMarket}
          />
          <div className="grid gap-mer-1">
            <FairEdge
              yesCents={displayedYes(cell?.quotes)}
              fair={fair.byMarket[selected.address]}
              status={fair.status}
              lastSuccessSecs={fair.lastSuccessSecs}
              nowSecs={ctx.nowSecs}
            />
            {fair.byMarket[selected.address] === undefined && fair.status !== "loading" ? (
              <p className="text-mer-sm text-mer-ink-muted">No fair value for this strike.</p>
            ) : null}
          </div>
          <a
            href={tradeHref(selected)}
            className="inline-flex min-h-9 items-center rounded-mer bg-mer-ink px-mer-3 text-mer-sm font-semibold text-mer-paper"
          >
            Trade this strike
            <span className="sr-only">
              : {ticker} {formatStrike(selected.strikeCents)}
            </span>
          </a>
        </div>
      )}

      <div className="grid min-w-0 gap-mer-6 lg:grid-cols-2">
        <div className="min-w-0">
          {priced ? (
            <DistributionChart ticker={ticker} points={points} nowSecs={ctx.nowSecs} />
          ) : (
            <p className="text-mer-sm text-mer-ink-muted" data-testid="distribution-empty">
              {emptyDistributionText(ticker)}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <PriceLineChart
            ticker={ticker}
            nowSecs={ctx.nowSecs}
            strikes={ladder.map((market) => market.strikeCents)}
            selectedStrikeCents={selected?.strikeCents ?? null}
          />
        </div>
      </div>
    </section>
  );
}
