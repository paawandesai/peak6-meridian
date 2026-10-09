"use client";

import type { PublicKey } from "@solana/web3.js";
import { useMemo } from "react";

import { BookPanel } from "./book-panel";
import { OrderPanel } from "./order-panel";
import { WalletActions } from "./wallet-actions";
import { ownOrders } from "../_lib/book-view";
import type { Holdings } from "../_lib/constraint";
import { MIDPOINT_NOTE, openClose, question, settlementRule, timeline } from "../_lib/copy";
import type { TradeReader } from "../_lib/reader";
import { badgeProps, nextTransition, panelState } from "../_lib/state";
import type { TradeActions } from "../_lib/tx";
import { usePolled } from "../_lib/use-polled";
import { AsOf, Countdown, StateBadge } from "@/components/ui";
import type { AppConfig } from "@/lib/chain";
import { formatUsdCents } from "@/lib/display";
import type { MarketData } from "@/lib/market-data";
import type { MarketRow } from "@/lib/markets";
import { formatEtHms } from "@/lib/time";

type Props = {
  readonly market: MarketRow;
  readonly config: AppConfig;
  readonly nowSecs: number;
  readonly reader: TradeReader;
  /** `null` until a wallet is connected. */
  readonly actions: TradeActions | null;
  readonly wallet: PublicKey | null;
  readonly marketData: Pick<MarketData, "prices" | "pricesUnavailable">;
  readonly explorerUrl: (signature: string) => string;
  readonly debounceMs?: number;
};

/** Live stock price with its "as of" time (design.md §3 "Data staleness and time"). */
function LivePrice({
  market,
  marketData,
  nowSecs,
}: {
  readonly market: MarketRow;
  readonly marketData: Props["marketData"];
  readonly nowSecs: number;
}) {
  const price = (
    marketData.prices as Record<string, MarketData["prices"][keyof MarketData["prices"]]>
  )[market.ticker];
  if (price === undefined) {
    return (
      <span className="text-mer-sm text-mer-ink-muted">{market.ticker} price unavailable</span>
    );
  }
  const asOfSecs = Math.floor(Date.parse(price.as_of) / 1000);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-mer-2 text-mer-sm">
      <span className="mer-num font-semibold">
        {market.ticker} {formatUsdCents(BigInt(price.price_cents))}
      </span>
      <AsOf time={formatEtHms(asOfSecs)} ageSecs={Math.max(0, nowSecs - asOfSecs)} />
    </span>
  );
}

/** The Trade page body for one strike (FR-17, FR-18; design.md §2 Trade, §5 Trade). */
export function TradeView(props: Props) {
  const { market, config, nowSecs, reader, actions, wallet, explorerUrl } = props;
  const walletKey = wallet?.toBase58() ?? "";
  const book = usePolled(() => reader.getBook(), 1_000, market.address);
  const walletView = usePolled(
    () => (wallet === null ? Promise.resolve(null) : reader.getWallet(wallet)),
    2_000,
    `${market.address}:${walletKey}`,
  );
  const openTime = usePolled(() => reader.getOpenTime(), 3_600_000, market.address);

  const panel = panelState(market, config, nowSecs);
  const transition = nextTransition(market, config, nowSecs);
  const fullBook = book.state.status === "ready" ? book.state.value : null;
  const walletData = walletView.state.status === "ready" ? walletView.state.value : null;
  const own = useMemo(
    () => (fullBook === null || walletKey === "" ? [] : ownOrders(fullBook, walletKey)),
    [fullBook, walletKey],
  );
  // Fail closed: if wallet is loading or errored, block all intents until ready.
  // Defaulting to 0 would bypass the position constraint when a wallet *is* connected but slow/failed.
  // When no wallet is connected (walletData === null after ready), holdings of 0 is safe.
  const holdings: Holdings | null =
    walletView.state.status === "ready"
      ? {
          yes: walletData?.yes ?? 0n,
          no: walletData?.no ?? 0n,
          freeYes: walletData?.freeYes ?? 0n,
          // Only a Buy NO rest (YES Ask while holding NO) is the exception; a Sell YES rest is not.
          hasRestingAsk: own.some((order) => order.side === "Ask") && (walletData?.no ?? 0n) > 0n,
          // Any resting asks (Sell YES or Buy NO) escrow YES; count as held for Buy NO constraint.
          escrowedYesFromAsks: own.some((order) => order.side === "Ask"),
        }
      : null;
  const refresh = (): void => {
    book.refresh();
    walletView.refresh();
  };

  return (
    <div className="grid gap-mer-6">
      <header className="grid gap-mer-2">
        <h1 className="text-mer-xl font-semibold">{question(market, nowSecs)}</h1>
        <p className="text-mer-sm text-mer-ink-muted">{settlementRule(market)}</p>
        <p className="text-mer-sm text-mer-ink-muted">{timeline(market)}</p>
        <p className="text-mer-sm" data-testid="open-close">
          {openClose(market, openTime.state.status === "ready" ? openTime.state.value : null)}
        </p>
        <div className="flex flex-wrap items-center gap-mer-3">
          <StateBadge {...badgeProps(market, config, nowSecs)} />
          {transition === null ? null : (
            <Countdown secondsLeft={transition.secondsLeft} label={transition.label} />
          )}
          <LivePrice market={market} marketData={props.marketData} nowSecs={nowSecs} />
        </div>
        <p className="text-mer-xs text-mer-ink-muted">{MIDPOINT_NOTE}</p>
      </header>
      <div className="grid gap-mer-6 md:grid-cols-[1fr_1.4fr]">
        <div className="order-2 md:order-1">
          <BookPanel book={fullBook} />
          {book.state.status === "error" ? (
            <p role="alert" className="text-mer-sm text-mer-loss">
              Could not read the book: {book.state.message}
            </p>
          ) : null}
        </div>
        <div className="order-1 grid gap-mer-6 md:order-2">
          <OrderPanel
            market={market}
            panel={panel}
            book={fullBook}
            holdings={holdings}
            user={wallet === null ? null : walletKey}
            actions={actions}
            explorerUrl={explorerUrl}
            onConfirmed={refresh}
            {...(props.debounceMs === undefined ? {} : { debounceMs: props.debounceMs })}
          />
          <WalletActions
            market={market}
            allow={panel.allow}
            wallet={walletData}
            ownOrders={own}
            actions={actions}
            explorerUrl={explorerUrl}
            onConfirmed={refresh}
          />
        </div>
      </div>
    </div>
  );
}
