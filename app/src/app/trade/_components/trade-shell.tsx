"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMemo } from "react";

import { TradeView } from "./trade-view";
import { createTradeReader } from "../_lib/reader";
import { createTradeActions } from "../_lib/tx";
import { AppHeader } from "@/components/app-header";
import { FaucetButton } from "@/components/faucet-button";
import { TickerInsight } from "@/components/fair-value/ticker-insight";
import { Providers } from "@/components/providers";
import { useReader } from "@/components/reader-context";
import { useTestMarkets } from "@/components/test-market-context";
import { useAsync } from "@/components/use-async";
import { useNow } from "@/components/use-now";
import { explorerTxUrl } from "@/lib/admin-chain";
import { loadPublicConfig } from "@/lib/config";
import { useMarketData } from "@/lib/market-data";
import { partitionMarkets } from "@/lib/markets";

export const NOT_FOUND_TEXT = "This market does not exist. Go back to Markets and pick a strike.";

function Page({ address }: { readonly address: string }) {
  const reader = useReader();
  const nowSecs = useNow();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const config = useMemo(() => loadPublicConfig(), []);
  const { showTestMarkets } = useTestMarkets();
  const marketsAll = useAsync(() => reader.listMarkets(), [reader]);
  const appConfig = useAsync(() => reader.getConfig(), [reader]);
  // P0-1 AC3-4: Filter to session markets; include test markets when toggle is on
  const markets = useMemo(() => {
    if (marketsAll.status !== "ready") return marketsAll;
    const { session, test } = partitionMarkets(marketsAll.value);
    const filtered = showTestMarkets ? [...session, ...test] : session;
    return { ...marketsAll, value: filtered };
  }, [marketsAll, showTestMarkets]);
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
  const tradeReader = useMemo(
    () => (market === undefined ? null : createTradeReader(config, market)),
    [config, market],
  );
  const actions = useMemo(
    () =>
      market === undefined || publicKey === null || signTransaction === undefined
        ? null
        : createTradeActions(connection, { publicKey, signTransaction }, config, market),
    [connection, publicKey, signTransaction, config, market],
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
      <div className="grid gap-mer-8">
        <TradeView
          market={market}
          config={appConfig.value}
          nowSecs={nowSecs}
          reader={tradeReader}
          actions={actions}
          wallet={publicKey}
          marketData={marketData}
          explorerUrl={(signature) => explorerTxUrl(signature, config)}
        />
        <TickerInsight market={market} ladder={ladder} books={marketData.books} nowSecs={nowSecs} />
      </div>
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
      <main className="mx-auto max-w-5xl px-mer-4 py-mer-6">{body}</main>
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
