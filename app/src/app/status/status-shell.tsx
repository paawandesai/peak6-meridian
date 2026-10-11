"use client";

import { useMemo, useState } from "react";

import { StatusView } from "./status-view";
import { AppHeader } from "@/components/app-header";
import { BottomTabBar } from "@/components/app-shell/bottom-tab-bar";
import { FaucetButton } from "@/components/faucet-button";
import { Providers } from "@/components/providers";
import { useReader } from "@/components/reader-context";
import { useTestMarkets } from "@/components/test-market-context";
import { TestMarketToggle } from "@/components/ui";
import { useAsync } from "@/components/use-async";
import { useNow } from "@/components/use-now";
import { partitionMarkets } from "@/lib/markets";
import { etTradingDate } from "@/lib/time";
import type { MarketInvariant, StatusResponse } from "@/app/api/status/route";

/**
 * Vault balance from an /api/status row; `null` means the vault could not be read. The API sends
 * "0" both for an empty vault and for an unreadable one, so "0" is unreadable only when the API
 * also failed the invariant: a market with 0 pairs and an empty vault is a Pass, not unavailable.
 */
export function vaultOf(m: Pick<MarketInvariant, "vaultBase" | "invariantPass">): bigint | null {
  return m.vaultBase === "0" && !m.invariantPass ? null : BigInt(m.vaultBase);
}

/** YYYY-MM-DD format from YYYYMMDD */
function formatDate(yyyymmdd: number): string {
  const s = yyyymmdd.toString();
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Get trading date for yesterday (previous day in ET) */
function getYesterdayET(): number {
  const now = Date.now() / 1000; // unix seconds
  const yesterdayUnixSecs = now - 24 * 3600;
  // etTradingDate is imported at module level
  return etTradingDate(yesterdayUnixSecs);
}

function Page() {
  const reader = useReader();
  const nowSecs = useNow();
  const { showTestMarkets, setShowTestMarkets } = useTestMarkets();
  const marketsAll = useAsync(() => reader.listMarkets(), [reader]);
  // P0-1 AC3-4: Filter to session markets only (test markets hidden by default)
  const { testMarketCount, markets } = useMemo(() => {
    if (marketsAll.status !== "ready") return { testMarketCount: 0, markets: marketsAll };
    const { session, test } = partitionMarkets(marketsAll.value);
    const filtered = showTestMarkets ? [...session, ...test] : session;
    return { testMarketCount: test.length, markets: { ...marketsAll, value: filtered } };
  }, [marketsAll, showTestMarkets]);
  const appConfig = useAsync(() => reader.getConfig(), [reader]);

  // P1-6: Date selector for today (default) or yesterday
  const [selectedDate, setSelectedDate] = useState<number | null>(null);

  const statusData = useAsync(async (): Promise<StatusResponse> => {
    const dateParam = selectedDate ? `?date=${formatDate(selectedDate)}` : "";
    const showTestParam = showTestMarkets ? (dateParam ? "&" : "?") + "showTest=1" : "";
    const response = await fetch(`/api/status${dateParam}${showTestParam}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json() as Promise<StatusResponse>;
  }, [selectedDate, showTestMarkets]);

  const yesterdayDate = useMemo(() => getYesterdayET(), []);

  return (
    <>
      <AppHeader
        nowSecs={nowSecs}
        markets={markets.status === "ready" ? markets.value : null}
        config={appConfig.status === "ready" ? appConfig.value : null}
        currentPath="/status"
      >
        <FaucetButton />
      </AppHeader>
      <main className="mx-auto max-w-5xl px-mer-4 py-mer-6 pb-20 md:pb-mer-6">
        <div className="mb-mer-4 flex items-center justify-between">
          <h2 className="text-mer-xl font-semibold">Status</h2>

          {/* P1-6: Date selector */}
          <div className="flex gap-mer-2">
            <button
              onClick={() => setSelectedDate(null)}
              className={`rounded px-mer-3 py-mer-1 text-mer-sm ${
                selectedDate === null
                  ? "bg-mer-yes text-mer-ink"
                  : "bg-mer-surface text-mer-ink-muted hover:bg-mer-surface"
              }`}
            >
              Today
            </button>
            <button
              onClick={() => setSelectedDate(yesterdayDate)}
              className={`rounded px-mer-3 py-mer-1 text-mer-sm ${
                selectedDate === yesterdayDate
                  ? "bg-mer-yes text-mer-ink"
                  : "bg-mer-surface text-mer-ink-muted hover:bg-mer-surface"
              }`}
            >
              Yesterday
            </button>
          </div>
        </div>

        {/* P0-1: Test market toggle */}
        {testMarketCount > 0 ? (
          <div className="mb-mer-4">
            <TestMarketToggle
              testMarketCount={testMarketCount}
              showTestMarkets={showTestMarkets}
              onToggle={() => setShowTestMarkets(!showTestMarkets)}
            />
          </div>
        ) : null}

        {statusData.status === "loading" ? <p>Loading status…</p> : null}
        {statusData.status === "error" ? (
          <p role="alert">Could not load status: {statusData.message}</p>
        ) : null}
        {statusData.status === "ready" && statusData.value.s === "error" ? (
          <p role="alert">Error: {statusData.value.error}</p>
        ) : null}
        {statusData.status === "ready" &&
        statusData.value.s === "ok" &&
        statusData.value.markets ? (
          <StatusView
            data={{
              markets: statusData.value.markets.map((m) => ({
                address: m.address,
                ticker: m.ticker,
                strikeCents: BigInt(m.strikeCents),
                tradingDate: statusData.value.date ?? 0,
                settled: m.settled,
                settlePrice: null,
                closeTs: BigInt(m.closeTs),
                pairsOutstanding: BigInt(m.pairsOutstanding),
                outcome: m.outcome,
                settlePriceScaled: 0n,
                settledAt: BigInt(m.settledAt),
              })),
              vaults: new Map(statusData.value.markets.map((m) => [m.address, vaultOf(m)])),
              facts: new Map(
                statusData.value.markets.map((m) => [
                  m.address,
                  {
                    createdAt: m.createdAt > 0 ? m.createdAt : null,
                    settledAt: m.settledAt > 0 ? m.settledAt : null,
                    settleSlot: m.settleSlot > 0 ? m.settleSlot : null,
                    oracleSlot: m.oracleAsOf > 0 ? BigInt(m.oracleAsOf) : null,
                  },
                ]),
              ),
            }}
          />
        ) : null}
      </main>
      <BottomTabBar />
    </>
  );
}

export function StatusShell() {
  return (
    <Providers>
      <Page />
    </Providers>
  );
}
