"use client";

import type { PublicKey } from "@solana/web3.js";
import { useMemo } from "react";

import { BookPanel } from "./book-panel";
import { OrderPanel } from "./order-panel";
import { PriceFair } from "./price-fair";
import { WalletActions } from "./wallet-actions";
import { displayedYesOfLevels, levelsOf, ownOrders } from "../_lib/book-view";
import type { Holdings } from "../_lib/constraint";
import { MIDPOINT_NOTE, openClose, question, settlementRule, timeline } from "../_lib/copy";
import type { TradeReader, WalletView } from "../_lib/reader";
import { badgeProps, nextTransition, panelState } from "../_lib/state";
import type { TradeActions } from "../_lib/tx";
import { usePolled } from "../_lib/use-polled";
import { distributionPoints, fairStaleness } from "@/components/distribution-chart/distribution";
import { DistributionSection } from "@/components/distribution-chart/distribution-section";
import { Countdown, StateBadge, VaultInvariantChip } from "@/components/ui";
import { PythPrice, PythPricePlaceholder, PythPriceUnavailable } from "@/components/pyth-price";
import type { AppConfig } from "@/lib/chain";
import type { FairValues } from "@/lib/fair-values";
import type { MarketBook, MarketData } from "@/lib/market-data";
import type { MarketRow } from "@/lib/markets";
import { OPEN_TIMES_REFRESH_MS } from "@/lib/open-times-core";
import { usePythQuotes } from "@/lib/use-pyth-quotes";

/** The ticker's ladder, its polled book quotes and the fair values, all read by the shell. */
export type TradeInsight = {
  /** Every market of the same ticker and trading date. */
  readonly ladder: readonly MarketRow[];
  readonly books: Readonly<Record<string, MarketBook>>;
  readonly fair: FairValues;
};

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
  /**
   * Ladder, quotes and fair values for the price line and the distribution chart. The shell reads
   * them with its existing pollers, so this page adds none. Defaults to this strike alone.
   */
  readonly insight?: TradeInsight;
};

const NO_FAIR: FairValues = { status: "unavailable", byMarket: {}, refreshFailed: false };

/** Live stock price from Pyth with freshness indicator (M3-10, D-055). */
function LivePrice({ market, nowSecs }: { readonly market: MarketRow; readonly nowSecs: number }) {
  const pythQuotes = usePythQuotes([market.ticker as never]);
  const quote = pythQuotes.quotes[market.ticker];
  const isUnavailable = !pythQuotes.loading && quote === undefined;

  if (pythQuotes.loading || quote === undefined) {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-mer-2 text-mer-sm">
        <span className="mer-num font-semibold">{market.ticker}</span>
        {isUnavailable ? <PythPriceUnavailable ticker={market.ticker} /> : <PythPricePlaceholder />}
      </span>
    );
  }

  return (
    <span className="inline-flex items-baseline gap-mer-2 text-mer-sm">
      <span className="mer-num font-semibold">{market.ticker}</span>
      <PythPrice quote={quote} nowMs={nowSecs * 1000} />
    </span>
  );
}

/**
 * The distribution points of the ladder. This strike's YES comes from its own full book (read
 * every second) so the chart, the price line and the book agree; the rest from the shell's quotes.
 */
function ladderPoints(
  insight: TradeInsight,
  market: MarketRow,
  ownYes: number | null,
  haveBook: boolean,
  nowSecs: number,
) {
  const quotes = Object.fromEntries(
    Object.entries(insight.books).map(([address, book]) => [
      address,
      book.state === "ready" ? book.quotes : null,
    ]),
  );
  const fair = Object.fromEntries(
    Object.entries(insight.fair.byMarket).map(([address, value]) => [address, value.fair_cents]),
  );
  const staleness = fairStaleness(insight.fair.byMarket, insight.fair.refreshFailed, nowSecs);
  return distributionPoints(insight.ladder, quotes, fair, staleness).map((point) =>
    point.market === market.address && haveBook ? { ...point, yesCents: ownYes } : point,
  );
}

/** The Trade page body for one strike (FR-17, FR-18; design.md §2 Trade, §5 Trade). */
export function TradeView(props: Props) {
  const { market, config, nowSecs, reader, actions, wallet, explorerUrl } = props;
  const walletKey = wallet?.toBase58() ?? "";
  // One read carries the book AND the vault invariant inputs (P0-7: no extra request). P1-2: on a
  // reader with account subscriptions both are pushed; polling (1 s / 2 s) is the fallback.
  const snapshotSource = useMemo(() => reader.snapshotSource?.(1_000) ?? null, [reader]);
  const snapshot = usePolled(() => reader.getSnapshot(), 1_000, market.address, snapshotSource);
  const walletSource = useMemo(
    () => (wallet === null ? null : (reader.walletSource?.(wallet, 2_000) ?? null)),
    [reader, wallet],
  );
  const walletView = usePolled<WalletView | null>(
    () => (wallet === null ? Promise.resolve(null) : reader.getWallet(wallet)),
    2_000,
    `${market.address}:${walletKey}`,
    walletSource,
  );
  // P1-4: re-read every minute until known (a just-created market reaches the index within one).
  const openTime = usePolled(() => reader.getOpenTime(), OPEN_TIMES_REFRESH_MS, market.address);

  const panel = panelState(market, config, nowSecs);
  const transition = nextTransition(market, config, nowSecs);
  const fullBook = snapshot.state.status === "ready" ? snapshot.state.value.book : null;
  const vault = snapshot.state.status === "ready" ? snapshot.state.value.vault : null;
  const insight = props.insight ?? { ladder: [market], books: {}, fair: NO_FAIR };
  const ownYes = useMemo(
    () => (fullBook === null ? null : displayedYesOfLevels(levelsOf(fullBook))),
    [fullBook],
  );
  const points = ladderPoints(insight, market, ownYes, fullBook !== null, nowSecs);
  const walletData = walletView.state.status === "ready" ? walletView.state.value : null;
  const own = useMemo(
    () => (fullBook === null || walletKey === "" ? [] : ownOrders(fullBook, walletKey)),
    [fullBook, walletKey],
  );
  // Fail closed: block all intents if a connected wallet's data is still loading or errored.
  // When no wallet is connected (wallet prop is null), holdings default to 0 (safe: nothing to hold).
  // When wallet IS connected but walletView isn't ready yet, holdings must be null (fail closed).
  const holdings: Holdings | null =
    wallet === null
      ? {
          yes: 0n,
          no: 0n,
          freeYes: 0n,
          hasRestingAsk: false,
          escrowedYesFromAsks: false,
        }
      : walletView.state.status === "ready" && walletData !== null
        ? {
            yes: walletData.yes,
            no: walletData.no,
            freeYes: walletData.freeYes,
            // Only a Buy NO rest (YES Ask while holding NO) is the exception; a Sell YES rest is not.
            hasRestingAsk: own.some((order) => order.side === "Ask") && walletData.no > 0n,
            // Any resting asks (Sell YES or Buy NO) escrow YES; count as held for Buy NO constraint.
            escrowedYesFromAsks: own.some((order) => order.side === "Ask"),
          }
        : null;
  const refresh = (): void => {
    snapshot.refresh();
    walletView.refresh();
  };

  return (
    <div className="grid gap-mer-6">
      <header className="grid gap-mer-2">
        <h1 className="text-mer-xl font-semibold">{question(market, nowSecs)}</h1>
        <p className="text-mer-sm text-mer-ink-muted">{settlementRule(market)}</p>
        <p className="text-mer-sm text-mer-ink-muted">{timeline(market)}</p>
        <p className="text-mer-sm" data-testid="open-close">
          {openClose(
            market,
            openTime.state.status === "ready"
              ? openTime.state.value
              : openTime.state.status === "error"
                ? "unavailable"
                : null,
          )}
        </p>
        <div className="flex flex-wrap items-center gap-mer-3">
          <StateBadge {...badgeProps(market, config, nowSecs)} />
          {transition === null ? null : (
            <Countdown secondsLeft={transition.secondsLeft} label={transition.label} />
          )}
          <LivePrice market={market} nowSecs={nowSecs} />
        </div>
        <PriceFair
          marketAddress={market.address}
          yesCents={ownYes}
          fair={insight.fair}
          nowSecs={nowSecs}
        />
        <div>
          <VaultInvariantChip
            pairs={vault?.pairs ?? null}
            balance={vault?.balance ?? null}
            // While the subscriptions are live any change is pushed, so the reading is current now.
            asOfSecs={vault === null ? null : snapshot.live ? nowSecs : vault.asOfSecs}
          />
        </div>
        <p className="text-mer-xs text-mer-ink-muted">{MIDPOINT_NOTE}</p>
      </header>
      <div className="grid gap-mer-6 md:grid-cols-[1fr_1.4fr]">
        <div className="order-2 grid content-start gap-mer-6 md:order-1">
          <div>
            <BookPanel book={fullBook} />
            {snapshot.state.status === "error" ? (
              <p role="alert" className="text-mer-sm text-mer-loss">
                Could not read the book: {snapshot.state.message}
              </p>
            ) : null}
          </div>
          <DistributionSection ticker={market.ticker} points={points} nowSecs={nowSecs} />
        </div>
        <div className="order-1 grid content-start gap-mer-6 md:order-2">
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
