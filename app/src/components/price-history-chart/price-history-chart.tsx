"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from "lightweight-charts";

type PythHistoryData = {
  s: "ok" | "no_data" | "error";
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
};

type Props = {
  readonly ticker: string;
  readonly nowSecs: number;
  /** Strike prices in cents (will be converted to dollars for display). */
  readonly strikes?: readonly bigint[];
  /** Fair value in cents (will be converted to dollars for display). */
  readonly fairValueCents?: number;
};

async function fetchHistory(ticker: string, nowSecs: number): Promise<PythHistoryData> {
  const symbol = `Equity.US.${ticker}/USD`;
  // 5-minute bucket: round nowSecs down to nearest 300s
  const toBucket = Math.floor(nowSecs / 300) * 300;
  const from = toBucket - 7 * 24 * 60 * 60; // 7 days ago
  const resolution = "60"; // 1-hour candles

  const url = new URL("/api/pyth-history", window.location.origin);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("resolution", resolution);
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(toBucket));

  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(6_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Get CSS custom property value from the document.
 */
function getCssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** TradingView Lightweight Charts price history from Pyth Pro with strike lines (M3-03).
 * P0-2: collapsed by default, created once per ticker, fetches on 5-min bucket, keeps last good data.
 */
export function PriceHistoryChart({ ticker, nowSecs, strikes, fairValueCents }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [lastGoodData, setLastGoodData] = useState<PythHistoryData | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  // Create chart once per ticker
  useEffect(() => {
    if (!containerRef.current || !isOpen) return;

    const bgColor = getCssVar("--mer-paper") || "#F7F9FC";
    const textColor = getCssVar("--mer-ink") || "#13233A";
    const gridColor = getCssVar("--mer-rule") || "#D5DDE8";
    const gainColor = getCssVar("--mer-gain") || "#146C43";
    const lossColor = getCssVar("--mer-loss") || "#B42318";

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: bgColor },
        textColor,
      },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;
    seriesRef.current = chart.addCandlestickSeries({
      upColor: gainColor,
      downColor: lossColor,
      borderUpColor: gainColor,
      borderDownColor: lossColor,
      wickUpColor: gainColor,
      wickDownColor: lossColor,
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [ticker, isOpen]);

  // Fetch data on ticker + 5-minute bucket
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    // Only show loading if we don't have cached data yet
    if (!lastGoodData) {
      setStatus("loading");
    }

    void fetchHistory(ticker, nowSecs)
      .then((data) => {
        if (cancelled) return;
        if (data.s !== "ok" || !data.t || !data.o || !data.h || !data.l || !data.c) {
          // Keep last good data if we have it
          if (
            lastGoodData &&
            lastGoodData.t &&
            lastGoodData.o &&
            lastGoodData.h &&
            lastGoodData.l &&
            lastGoodData.c &&
            seriesRef.current
          ) {
            // Re-apply cached data to the series
            const { t, o, h, l, c } = lastGoodData;
            const candles = t.map((time, i) => ({
              time: time as UTCTimestamp,
              open: o[i] ?? 0,
              high: h[i] ?? 0,
              low: l[i] ?? 0,
              close: c[i] ?? 0,
            }));
            seriesRef.current.setData(candles);
            chartRef.current?.timeScale().fitContent();
            setStatus("ready");
          } else {
            setStatus("empty");
          }
          return;
        }

        setLastGoodData(data);

        const { t, o, h, l, c } = data;
        const candles = t.map((time, i) => ({
          time: time as UTCTimestamp,
          open: o[i] ?? 0,
          high: h[i] ?? 0,
          low: l[i] ?? 0,
          close: c[i] ?? 0,
        }));

        if (seriesRef.current) {
          seriesRef.current.setData(candles);
          chartRef.current?.timeScale().fitContent();
        }
        setStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to fetch price history:", error);
        // Keep last good data if we have it
        if (
          lastGoodData &&
          lastGoodData.t &&
          lastGoodData.o &&
          lastGoodData.h &&
          lastGoodData.l &&
          lastGoodData.c &&
          seriesRef.current
        ) {
          // Re-apply cached data to the series
          const { t, o, h, l, c } = lastGoodData;
          const candles = t.map((time, i) => ({
            time: time as UTCTimestamp,
            open: o[i] ?? 0,
            high: h[i] ?? 0,
            low: l[i] ?? 0,
            close: c[i] ?? 0,
          }));
          seriesRef.current.setData(candles);
          chartRef.current?.timeScale().fitContent();
          setStatus("ready");
        } else {
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ticker, Math.floor(nowSecs / 300) * 300, isOpen]);

  // Update strike lines when strikes change (using stable stringified comparison)
  useEffect(() => {
    if (!seriesRef.current || status !== "ready") return;

    // Remove existing price lines
    priceLinesRef.current.forEach((line) => {
      seriesRef.current?.removePriceLine(line);
    });
    priceLinesRef.current = [];

    const mutedColor = getCssVar("--mer-ink-muted") || "#4A5B72";

    // Add strike lines
    if (strikes && strikes.length > 0) {
      strikes.forEach((strikeCents) => {
        const priceInDollars = Number(strikeCents) / 100;
        const line = seriesRef.current?.createPriceLine({
          price: priceInDollars,
          color: mutedColor,
          lineWidth: 1,
          lineStyle: 2, // dashed
          axisLabelVisible: true,
          title: `$${priceInDollars.toFixed(2)}`,
        });
        if (line) priceLinesRef.current.push(line);
      });
    }

    // Add fair value line
    if (fairValueCents !== undefined && fairValueCents !== null) {
      const yesColor = getCssVar("--mer-yes") || "#1E5BB8";
      const fairInDollars = fairValueCents / 100;
      const line = seriesRef.current?.createPriceLine({
        price: fairInDollars,
        color: yesColor,
        lineWidth: 2,
        lineStyle: 0, // solid
        axisLabelVisible: true,
        title: `Fair $${fairInDollars.toFixed(2)}`,
      });
      if (line) priceLinesRef.current.push(line);
    }
  }, [JSON.stringify(strikes?.map(String)), fairValueCents, status]);

  return (
    <details onToggle={(e) => setIsOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-mer-sm text-mer-ink-muted">
        Show price history · Pyth price, last 7 days (context only)
      </summary>
      <div className="mt-mer-2">
        {status === "loading" && (
          <p className="text-mer-sm text-mer-ink-muted">Loading price history…</p>
        )}
        {status === "empty" && (
          <p className="text-mer-sm text-mer-ink-muted">
            No price history (weekend / market closed)
          </p>
        )}
        {status === "error" && (
          <p className="text-mer-sm text-mer-ink-muted">Price history unavailable</p>
        )}
        <div
          ref={containerRef}
          className="h-48 w-full sm:h-64"
          style={{ display: status === "ready" ? "block" : "none" }}
        />
      </div>
    </details>
  );
}
