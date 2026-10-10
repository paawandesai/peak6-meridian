"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMemo } from "react";

import { TradeView } from "./trade-view";
import { createTradeReader } from "../_lib/reader";
import { createTradeActions } from "../_lib/tx";
import { AppHeader } from "@/components/app-header";
import { DemoMarketHeader } from "@/components/demo-banner";
import { ReplayGuard } from "@/components/replay-guard";
import { useReplay } from "@/components/use-replay";
import { BottomTabBar } from "@/components/app-shell/bottom-tab-bar";
import { FaucetButton } from "@/components/faucet-button";
import { PriceHistoryChart } from "@/components/price-history-chart/price-history-chart";
import { Providers } from "@/components/providers";
import { useReader } from "@/components/reader-context";
import { useAsync } from "@/components/use-async";
import { useNow } from "@/components/use-now";
import { explorerTxUrl } from "@/lib/admin-chain";
import { loadPublicConfig } from "@/lib/config";
import { useFairValues } from "@/lib/fair-values";
import { useMarketData } from "@/lib/market-data";
import { marketStatus, partitionMarkets } from "@/lib/markets";

export const NOT_FOUND_TEXT = "This market does not exist. Go back to Markets and pick a strike.";

function Page({ address }: { readonly address: string }) {
  const reader = useReader();
  const nowSecs = useNow();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const config = useMemo(() => loadPublicConfig(), []);
  // Replay is read-only: no signing actions and every control disabled (ReplayGuard).
  const readOnly = useReplay()?.kind === "replay";
  const marketsAll = useAsync(() => reader.listMarkets(), [reader]);
  const appConfig = useAsync(() => reader.getConfig(), [reader]);
  // P0-1 AC4: Filter to session markets only
  const markets = useMemo(() => {
    if (marketsAll.status !== "ready") return marketsAll;
    const { session } = partitionMarkets(marketsAll.value);
    return { ...marketsAll, value: session };
  }, [marketsAll]);
  const market =
    markets.status === "ready" ? markets.value.find((m) => m.address === address) : undefined;
  // Live prices, plus the books of the ticker's ladder for the distribution chart. The Trade
  // panel reads its own full book separately.
  const ladder =
    market === undefined || markets.status !== "ready"
      ? []
      : markets.value.filter(
          (m) => m.ticker === market.ticker && m.tradingDate === market.tradingDate,
        );
  const marketData = useMarketData(ladder);
  // One fair-value poller (5 s) for the price line and the distribution chart, as TickerInsight
  // had: only while some strike of the ladder is unsettled (and while the list is loading, so the
  // first paint says "loading" rather than "unavailable").
  const fair = useFairValues({
    enabled:
      markets.status === "loading" ||
      (nowSecs !== null && ladder.some((m) => marketStatus(m, nowSecs) !== "Settled")),
  });
  const tradeReader = useMemo(
    () => (market === undefined ? null : createTradeReader(config, market)),
    [config, market],
  );
  const actions = useMemo(
    () =>
      readOnly || market === undefined || publicKey === null || signTransaction === undefined
        ? null
        : createTradeActions(connection, { publicKey, signTransaction }, config, market),
    [readOnly, connection, publicKey, signTransaction, config, market],
  );

  let body;
  if (markets.status === "loading" || appConfig.status === "loading" || nowSecs === null) {
    body = <p role="status">Loading market…</p>;
  } else if (markets.status === "error") {
    body = <p role="alert">Could not load the market: {markets.message}</p>;
  } else if (appConfig.status === "error") {
    body = <p role="alert">Could not load the configuration: {appConfig.message}</p>;
  } else if (market === undefined || tradeReader === null) {
    body = <p role="alert">{NOT_FOUND_TEXT}</p>;
  } else {
    const ladder = markets.value.filter(
      (m) => m.ticker === market.ticker && m.tradingDate === market.tradingDate,
    );
    body = (
      <ReplayGuard active={readOnly}>
        <DemoMarketHeader market={market} />
        <TradeView
          market={market}
          config={appConfig.value}
          nowSecs={nowSecs}
          reader={tradeReader}
          actions={actions}
          wallet={publicKey}
          marketData={marketData}
          explorerUrl={(signature) => explorerTxUrl(signature, config)}
          insight={{ ladder, books: marketData.books, fair }}
        />
        <PriceHistoryChart
          ticker={market.ticker}
          nowSecs={nowSecs}
          strikes={ladder.map((m) => m.strikeCents)}
          fairValueCents={fair.byMarket[market.address]?.fair_cents}
        />
      </ReplayGuard>
    );
  }
  return (
    <>
      <AppHeader
        nowSecs={nowSecs}
        markets={markets.status === "ready" ? markets.value : null}
        config={appConfig.status === "ready" ? appConfig.value : null}
        currentPath={`/trade/${address}`}
      >
        <FaucetButton />
      </AppHeader>
      <main className="mx-auto max-w-5xl px-mer-4 py-mer-6 pb-20 md:pb-mer-6">{body}</main>
      <BottomTabBar />
    </>
  );
}

export function TradeShell({ address }: { readonly address: string }) {
  return (
    <Providers>
      <Page address={address} />
    </Providers>
  );
}
