"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";

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
  const to = nowSecs;
  const from = nowSecs - 7 * 24 * 60 * 60; // 7 days ago
  const resolution = "60"; // 1-hour candles

  const url = new URL("/api/pyth-history", window.location.origin);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("resolution", resolution);
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));

  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/** TradingView Lightweight Charts price history from Pyth Pro with strike lines (M3-03). */
export function PriceHistoryChart({ ticker, nowSecs, strikes, fairValueCents }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 300,
      layout: {
        background: { color: "#ffffff" },
        textColor: "#333",
      },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;
    const candlestickSeries = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    let cancelled = false;

    void fetchHistory(ticker, nowSecs)
      .then((data) => {
        if (cancelled) return;
        if (data.s !== "ok" || !data.t || !data.o || !data.h || !data.l || !data.c) {
          setStatus("empty");
          return;
        }

        const { t, o, h, l, c } = data;
        const candles = t.map((time, i) => ({
          time: time as UTCTimestamp,
          open: o[i] ?? 0,
          high: h[i] ?? 0,
          low: l[i] ?? 0,
          close: c[i] ?? 0,
        }));

        candlestickSeries.setData(candles);

        // Add strike lines (horizontal price lines at each strike)
        if (strikes && strikes.length > 0) {
          strikes.forEach((strikeCents) => {
            const priceInDollars = Number(strikeCents) / 100;
            candlestickSeries.createPriceLine({
              price: priceInDollars,
              color: "#94a3b8",
              lineWidth: 1,
              lineStyle: 2, // dashed
              axisLabelVisible: true,
              title: `$${priceInDollars.toFixed(2)}`,
            });
          });
        }

        // Add fair value line if available
        if (fairValueCents !== undefined && fairValueCents !== null) {
          const fairInDollars = fairValueCents / 100;
          candlestickSeries.createPriceLine({
            price: fairInDollars,
            color: "#3b82f6",
            lineWidth: 2,
            lineStyle: 0, // solid
            axisLabelVisible: true,
            title: `Fair $${fairInDollars.toFixed(2)}`,
          });
        }

        chart.timeScale().fitContent();
        setStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to fetch price history:", error);
        setStatus("error");
      });

    const handleResize = () => {
      if (containerRef.current && chart) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [ticker, nowSecs, strikes, fairValueCents]);

  return (
    <div>
      <h3 className="mb-2 text-mer-sm font-semibold">{ticker} Price History (7 days)</h3>
      {status === "loading" && (
        <p className="text-mer-sm text-mer-ink-muted">Loading price history…</p>
      )}
      {status === "empty" && (
        <p className="text-mer-sm text-mer-ink-muted">No price history available for {ticker}.</p>
      )}
      {status === "error" && (
        <p className="text-mer-sm text-mer-ink-muted">Could not load price history for {ticker}.</p>
      )}
      <div ref={containerRef} className="w-full" style={{ display: status === "ready" ? "block" : "none" }} />
    </div>
  );
}
