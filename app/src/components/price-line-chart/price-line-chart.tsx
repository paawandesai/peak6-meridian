"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import {
  bucketStart,
  HISTORY_RANGES,
  type HistoryPoint,
  type HistoryRange,
  historyQuery,
  historyUrl,
  parseHistory,
  RANGE_SPEC,
} from "./history";
import type { BoardTicker } from "@/components/trade-board/types";
import { formatUsdCents } from "@/lib/display";
import { formatStrike } from "@/lib/markets";
import { etTradingDate, formatEtDayHms, formatEtHm } from "@/lib/time";

export type PriceLineChartProps = {
  readonly ticker: BoardTicker;
  readonly nowSecs: number;
  /** Strikes of the primary close set, integer cents. */
  readonly strikes: readonly bigint[];
  readonly selectedStrikeCents: bigint | null;
};

export const FETCH_TIMEOUT_MS = 6_000;

/** lightweight-charts `LineStyle` values (the enum is not imported so tests can mock the module). */
const SOLID = 0;
const DASHED = 2;

type Outcome = "loading" | "ok" | "no_data" | "error";

/** The last good series and the range it belongs to. */
type Series = { readonly range: HistoryRange; readonly points: readonly HistoryPoint[] };

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/** `$181.42 at 14:50 ET`; the weekday is added when the close is not from today (ET). */
export function latestCloseText(point: HistoryPoint, nowSecs: number): string {
  const when =
    etTradingDate(point.timeSecs) === etTradingDate(nowSecs)
      ? formatEtHm(point.timeSecs)
      : formatEtDayHms(point.timeSecs, nowSecs);
  return `${formatUsdCents(BigInt(point.closeCents))} at ${when} ET`;
}

/**
 * The ticker's Pyth price over the last day or week as a line, with a horizontal line per strike
 * (the selected one solid and labelled). Fair value is never drawn here: it is a YES probability
 * in cents, not a share price. The chart is decorative; the caption carries the range and the
 * latest close as text. One fetch per range per 5-minute bucket; a failed refetch keeps the last
 * good series.
 */
export function PriceLineChart({
  ticker,
  nowSecs,
  strikes,
  selectedStrikeCents,
}: PriceLineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const [range, setRange] = useState<HistoryRange>("1D");
  const [outcome, setOutcome] = useState<Outcome>("loading");
  const [series, setSeries] = useState<Series | null>(null);
  const bucket = bucketStart(nowSecs);

  // The chart and its one line series: created once per mount, removed on unmount, sized by the
  // container (`autoSize`).
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const ink = cssVar("--mer-ink", "#13233a");
    const chart = createChart(container, {
      autoSize: true,
      layout: { background: { color: cssVar("--mer-paper", "#f7f9fc") }, textColor: ink },
      grid: {
        vertLines: { color: cssVar("--mer-rule", "#d5dde8") },
        horzLines: { color: cssVar("--mer-rule", "#d5dde8") },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addLineSeries({ color: ink, lineWidth: 2 });
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, []);

  // One request per (ticker, range, 5-minute bucket); aborted on change and unmount.
  useEffect(() => {
    const controller = new AbortController();
    setOutcome("loading");
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(historyUrl(historyQuery(ticker, range, bucket)), { signal });
        if (!response.ok) {
          if (!controller.signal.aborted) setOutcome("error");
          return;
        }
        const parsed = parseHistory(await response.json());
        if (controller.signal.aborted) return;
        if (parsed.kind === "ok" && parsed.points.length > 0) {
          setSeries({ range, points: parsed.points });
          setOutcome("ok");
        } else {
          setOutcome(parsed.kind === "error" ? "error" : "no_data");
        }
      } catch {
        if (!controller.signal.aborted) setOutcome("error");
      }
    };
    void load();
    return () => controller.abort();
  }, [ticker, range, bucket]);

  // The last good series for the range shown, kept through a failed refetch.
  const points = series !== null && series.range === range ? series.points : null;
  const hasData = points !== null && points.length > 0;

  useEffect(() => {
    if (seriesRef.current === null || points === null) return;
    seriesRef.current.setData(
      // Display only: cents to dollars for the chart's axis.
      points.map((p) => ({ time: p.timeSecs as UTCTimestamp, value: p.closeCents / 100 })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  const strikesKey = strikes.map(String).join(",");
  useEffect(() => {
    const line = seriesRef.current;
    if (line === null) return;
    linesRef.current.forEach((priceLine) => line.removePriceLine(priceLine));
    const ink = cssVar("--mer-ink", "#13233a");
    const primary = cssVar("--mer-primary", cssVar("--mer-focus", "#1e5bb8"));
    linesRef.current = strikes.map((strikeCents) => {
      const selected = strikeCents === selectedStrikeCents;
      return line.createPriceLine({
        // Display only: cents to dollars for the chart's axis.
        price: Number(strikeCents) / 100,
        color: selected ? primary : ink,
        lineWidth: selected ? 2 : 1,
        lineStyle: selected ? SOLID : DASHED,
        axisLabelVisible: selected,
        title: selected ? formatStrike(strikeCents) : "",
      });
    });
    // `strikesKey` stands for `strikes`, so a new array with the same strikes does not redraw.
  }, [strikesKey, selectedStrikeCents]);

  const latest = points?.[points.length - 1];
  const captionId = `price-line-${ticker}`;
  return (
    <figure className="grid min-w-0 gap-mer-2" aria-labelledby={captionId}>
      <div className="flex flex-wrap items-baseline justify-between gap-mer-2">
        <figcaption id={captionId} className="text-mer-md font-semibold">
          {ticker} price, {RANGE_SPEC[range].words}
          {latest === undefined ? null : (
            <span className="mer-num block text-mer-sm font-normal text-mer-ink-muted">
              {latestCloseText(latest, nowSecs)}
            </span>
          )}
        </figcaption>
        <div role="group" aria-label="Price history range" className="flex gap-mer-1">
          {HISTORY_RANGES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === range}
              onClick={() => setRange(option)}
              className={`min-h-9 rounded-mer border border-mer-control-border px-mer-2 text-mer-sm ${
                option === range ? "bg-mer-ink text-mer-paper" : ""
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      {hasData ? null : (
        <p className="text-mer-sm text-mer-ink-muted" role="status" data-testid="price-line-state">
          {outcome === "error"
            ? "Price history unavailable."
            : outcome === "loading"
              ? "Loading price history…"
              : "No price history from Pyth right now."}
        </p>
      )}
      <div
        ref={containerRef}
        aria-hidden="true"
        className="h-48 w-full min-w-0 sm:h-64"
        style={{ display: hasData ? "block" : "none" }}
        data-testid="price-line-canvas"
      />
    </figure>
  );
}
