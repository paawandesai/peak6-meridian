"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useMemo, useState } from "react";

import { createActions, type PortfolioActions, type RedeemItem } from "./actions";
import { createPortfolioSource, type PortfolioSource } from "./data";
import { marketLabel } from "./label";
import { MmBlock } from "./mm-block";
import { buildPortfolio, type PortfolioModel, type PositionRow, type RowState } from "./model";
import { DemoBadge } from "@/components/demo-banner";
import { useReader } from "@/components/reader-context";
import { useTestMarkets } from "@/components/test-market-context";
import {
  Countdown,
  Pnl,
  PortfolioFilters,
  type PortfolioTotals,
  SideLabel,
  StateBadge,
  type StateBadgeProps,
  TestMarketBadge,
  TestMarketToggle,
  TxStatus,
  type TxStatusProps,
} from "@/components/ui";
import { useAsync } from "@/components/use-async";
import { loadPublicConfig } from "@/lib/config";
import { isDemoMarket } from "@/lib/demo-session";
import {
  formatPriceTenths,
  formatUsdCents,
  formatUsdSigned,
  scaledToCentsFloor,
} from "@/lib/display";
import { type MarketData, type MarketDataSources, useMarketData } from "@/lib/market-data";
import {
  formatStrike,
  isSessionMarket,
  type MarketRow,
  marketStatus,
  partitionMarkets,
  SETTLING_START_SECS,
} from "@/lib/markets";
import { tenthsToBase, type YesQuotes } from "@/lib/pnl";
import { formatCountdown, formatEtHm } from "@/lib/time";

export const MARK_FOOTNOTE = "Mark is the book midpoint, not a guaranteed sale price.";
export const CONNECT_COPY = "Connect your wallet to see your positions, P&L and winnings.";

type Filter = "open" | "resting" | "closed";

export { marketLabel } from "./label";

const signOf = (value: bigint): "gain" | "loss" | "zero" =>
  value > 0n ? "gain" : value < 0n ? "loss" : "zero";

function PnlCell({ value }: { readonly value: bigint | null }) {
  if (value === null) return <span aria-label="not available">—</span>;
  return <Pnl text={formatUsdSigned(value, "always")} sign={signOf(value)} />;
}

function badgeFor(
  market: MarketRow,
  nowSecs: number,
  overrideDelaySecs: bigint,
): StateBadgeProps | null {
  const status = marketStatus(market, nowSecs);
  const now = BigInt(nowSecs);
  switch (status) {
    case "Open":
      return { state: "open" };
    case "ClosingSoon":
      return { state: "closing-soon", remaining: formatCountdown(Number(market.closeTs - now)) };
    case "Closed":
      return { state: "closed", settlingAt: formatEtHm(market.closeTs + SETTLING_START_SECS) };
    case "Settling":
      return { state: "settling" };
    case "SettlementDelayed": {
      const at = market.closeTs + overrideDelaySecs;
      return { state: "settlement-delayed", overrideAt: now >= at ? "now" : formatEtHm(at) };
    }
    case "Settled":
      return market.outcome === "None"
        ? null
        : {
            state: "settled",
            outcome: market.outcome === "Yes" ? "YES" : "NO",
            price: formatUsdCents(scaledToCentsFloor(market.settlePriceScaled)),
          };
  }
}

function StateCell({
  row,
  nowSecs,
  overrideDelaySecs,
}: {
  readonly row: PositionRow;
  readonly nowSecs: number | null;
  readonly overrideDelaySecs: bigint;
}) {
  const { market } = row;
  if (market.settled) {
    const badge = badgeFor(market, 0, overrideDelaySecs);
    return (
      <span className="flex flex-col gap-mer-1">
        {badge === null ? <span>Settled</span> : <StateBadge {...badge} />}
        <span className="text-mer-xs text-mer-ink-muted">
          {row.state === "won"
            ? "Won: pays $1.00 a contract"
            : row.state === "lost"
              ? "Lost: pays $0.00"
              : "Redeemed"}
        </span>
      </span>
    );
  }
  if (nowSecs === null) return <span>—</span>;
  const badge = badgeFor(market, nowSecs, overrideDelaySecs);
  const left = Number(market.closeTs - BigInt(nowSecs));
  return (
    <span className="flex flex-col gap-mer-1">
      {badge === null ? null : <StateBadge {...badge} />}
      {row.state === "open" && left > 0 ? (
        <span className="text-mer-xs">
          <Countdown secondsLeft={left} />
        </span>
      ) : null}
      {row.state === "exited" ? <span className="text-mer-xs">Exited</span> : null}
    </span>
  );
}

function PositionsTable({
  rows,
  nowSecs,
  overrideDelaySecs,
  onRedeem,
  busy,
  firstUse,
}: {
  readonly rows: readonly PositionRow[];
  readonly nowSecs: number | null;
  readonly overrideDelaySecs: bigint;
  readonly onRedeem: (market: MarketRow) => void;
  readonly busy: boolean;
  readonly firstUse: ReadonlySet<string>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-mer-sm">
        <caption className="sr-only">Positions</caption>
        <thead>
          <tr className="text-left text-mer-ink-muted">
            <th scope="col" className="py-mer-1 pr-mer-2 font-medium">
              Market
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 font-medium">
              Side
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 text-right font-medium">
              Qty
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 text-right font-medium">
              Avg entry
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 text-right font-medium">
              Mark
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 text-right font-medium">
              If right pays
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 text-right font-medium">
              Unrealized
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 text-right font-medium">
              Realized
            </th>
            <th scope="col" className="py-mer-1 font-medium">
              State
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-mer-rule align-top">
              <th scope="row" className="py-mer-2 pr-mer-2 text-left font-medium">
                <div className="flex items-center gap-mer-1">
                  {marketLabel(row.market)}
                  {!isSessionMarket(row.market) && !isDemoMarket(row.market) ? (
                    <TestMarketBadge />
                  ) : null}
                  <DemoBadge market={row.market} />
                </div>
              </th>
              <td className="py-mer-2 pr-mer-2">
                <SideLabel
                  side={row.side}
                  {...(firstUse.has(row.key)
                    ? {
                        meaning:
                          row.side === "YES"
                            ? `pays $1.00 if ${row.market.ticker} closes at or above ${formatStrike(row.market.strikeCents)}`
                            : `pays $1.00 if ${row.market.ticker} closes below ${formatStrike(row.market.strikeCents)}`,
                      }
                    : {})}
                />
              </td>
              <td className="mer-num py-mer-2 pr-mer-2 text-right">{row.qty.toString()}</td>
              <td className="mer-num py-mer-2 pr-mer-2 text-right">
                {row.cost === null || row.qty === 0n ? "—" : formatPriceTenths(row.cost, row.qty)}
              </td>
              <td className="mer-num py-mer-2 pr-mer-2 text-right">
                {row.mark === null ? "—" : formatPriceTenths(tenthsToBase(row.mark))}
              </td>
              <td className="mer-num py-mer-2 pr-mer-2 text-right">
                {formatUsdSigned(row.ifRightPays)}
              </td>
              <td className="py-mer-2 pr-mer-2 text-right">
                <PnlCell value={row.unrealized} />
              </td>
              <td className="py-mer-2 pr-mer-2 text-right">
                <PnlCell value={row.realized} />
              </td>
              <td className="py-mer-2">
                <StateCell row={row} nowSecs={nowSecs} overrideDelaySecs={overrideDelaySecs} />
                {row.state === "won" && row.walletQty > 0n ? (
                  <button
                    type="button"
                    className="mt-mer-1 rounded-mer border border-mer-control-border px-mer-2 py-mer-1 text-mer-sm font-medium disabled:opacity-50"
                    disabled={busy}
                    onClick={() => onRedeem(row.market)}
                  >
                    Redeem {formatUsdSigned(row.walletQty * 1_000_000n)}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RestingTable({ model }: { readonly model: PortfolioModel }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-mer-sm">
        <caption className="sr-only">Resting orders</caption>
        <thead>
          <tr className="text-left text-mer-ink-muted">
            <th scope="col" className="py-mer-1 pr-mer-2 font-medium">
              Market
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 font-medium">
              Order
            </th>
            <th scope="col" className="py-mer-1 pr-mer-2 text-right font-medium">
              Price
            </th>
            <th scope="col" className="py-mer-1 text-right font-medium">
              Qty
            </th>
          </tr>
        </thead>
        <tbody>
          {model.resting.map((order) => (
            <tr key={`${order.market}:${order.orderId}`} className="border-t border-mer-rule">
              <th scope="row" className="py-mer-2 pr-mer-2 text-left font-medium">
                {marketLabel(order.marketRow)}
              </th>
              <td className="py-mer-2 pr-mer-2">
                {order.side === "Bid" ? "Buy YES (bid)" : "Sell YES (ask)"}
              </td>
              <td className="mer-num py-mer-2 pr-mer-2 text-right">{order.price}¢</td>
              <td className="mer-num py-mer-2 text-right">{order.qty.toString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function explorerUrl(signature: string, cluster: "devnet" | "localnet", rpcUrl: string): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  return cluster === "devnet"
    ? `${base}?cluster=devnet`
    : `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
}

/** The first row of each (market, side) pair per page gets the one-line meaning (design.md §3). */
function firstUseKeys(rows: readonly PositionRow[]): ReadonlySet<string> {
  const seen = new Set<"YES" | "NO">();
  const keys = new Set<string>();
  for (const row of rows) {
    if (!seen.has(row.side)) {
      seen.add(row.side);
      keys.add(row.key);
    }
  }
  return keys;
}

const FILTER_STATES: Record<Exclude<Filter, "resting">, readonly RowState[]> = {
  open: ["open"],
  closed: ["won", "lost", "exited"],
};

export type PortfolioViewProps = {
  /** Test seams; the page uses the browser defaults. */
  readonly source?: PortfolioSource;
  readonly actions?: PortfolioActions;
  readonly marketSources?: MarketDataSources;
  readonly nowSecs?: number | null;
};

export function PortfolioView(props: PortfolioViewProps) {
  const { publicKey, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const reader = useReader();
  const { showTestMarkets, setShowTestMarkets } = useTestMarkets();
  const config = useMemo(() => loadPublicConfig(), []);
  const source = useMemo(
    () => props.source ?? createPortfolioSource(config),
    [props.source, config],
  );
  const [version, setVersion] = useState(0);
  const [filter, setFilter] = useState<Filter>("open");
  const [tx, setTx] = useState<TxStatusProps | null>(null);

  const marketsAll = useAsync(() => reader.listMarkets(), [reader]);
  // P0-1 AC3-4: Filter to session markets only (test markets hidden by default)
  const { testMarketCount, markets } = useMemo(() => {
    if (marketsAll.status !== "ready") return { testMarketCount: 0, markets: marketsAll };
    const { session, test } = partitionMarkets(marketsAll.value);
    const filtered = showTestMarkets ? [...session, ...test] : session;
    return { testMarketCount: test.length, markets: { ...marketsAll, value: filtered } };
  }, [marketsAll, showTestMarkets]);
  const settings = useAsync(() => reader.getConfig(), [reader]);
  const wallet = publicKey;
  const snapshot = useAsync(
    () =>
      wallet === null || markets.status !== "ready"
        ? new Promise<never>(() => undefined)
        : source.load(wallet, markets.value),
    [source, wallet, markets.status === "ready" ? markets.value : null, version],
  );
  const usdc = useAsync(
    () => (wallet === null ? Promise.resolve(null) : reader.usdcBalance(wallet)),
    [reader, wallet, version],
  );

  const held = useMemo(
    () =>
      snapshot.status === "ready" && markets.status === "ready"
        ? markets.value.filter(
            (market) =>
              snapshot.value.holdings[market.address] !== undefined ||
              snapshot.value.openOrders.some((row) => row.market === market.address) ||
              snapshot.value.events.some(
                (event) => "market" in event && event.market === market.address,
              ),
          )
        : [],
    [snapshot, markets],
  );
  const data: MarketData = useMarketData(held, props.marketSources);

  if (wallet === null) {
    return (
      <section className="flex flex-col items-start gap-mer-2">
        <p>{CONNECT_COPY}</p>
        <button
          type="button"
          className="rounded-mer border border-mer-control-border px-mer-3 py-mer-1 font-medium"
          onClick={() => setVisible(true)}
        >
          Connect wallet
        </button>
      </section>
    );
  }
  if (markets.status === "loading" || snapshot.status === "loading") {
    return <p role="status">Loading portfolio…</p>;
  }
  if (markets.status === "error") {
    return <p role="alert">Could not load markets: {markets.message}</p>;
  }
  if (snapshot.status === "error") {
    return <p role="alert">Could not load your portfolio: {snapshot.message}</p>;
  }

  const quotes: Record<string, YesQuotes | null> = {};
  for (const [address, book] of Object.entries(data.books)) {
    quotes[address] = book.state === "ready" ? book.quotes : null;
  }
  const model = buildPortfolio({
    wallet: wallet.toBase58(),
    markets: markets.value,
    snapshot: snapshot.value,
    quotes,
    usdcBalance: usdc.status === "ready" ? usdc.value : null,
  });
  const nowSecs = props.nowSecs ?? null;
  const overrideDelaySecs = settings.status === "ready" ? settings.value.overrideDelaySecs : 3600n;

  const sorted = [...model.rows].sort(
    (a, b) =>
      a.market.ticker.localeCompare(b.market.ticker) ||
      b.market.tradingDate - a.market.tradingDate ||
      (a.market.strikeCents < b.market.strikeCents
        ? -1
        : a.market.strikeCents > b.market.strikeCents
          ? 1
          : 0) ||
      a.side.localeCompare(b.side) * -1,
  );
  const shown =
    filter === "resting" ? [] : sorted.filter((row) => FILTER_STATES[filter].includes(row.state));
  const busy = tx !== null && tx.state !== "confirmed" && tx.state !== "failed";

  async function run(
    send: (actions: PortfolioActions) => Promise<{ signature: string; slot: number }>,
  ) {
    if (wallet === null) return;
    const actions =
      props.actions ??
      (signAllTransactions === undefined
        ? null
        : createActions(config, connection, { publicKey: wallet, signAllTransactions }));
    if (actions === null) {
      setTx({ state: "failed", reason: "this wallet cannot sign transactions" });
      return;
    }
    setTx({ state: "awaiting-signature" });
    try {
      const result = await send(actions);
      setTx({
        state: "confirmed",
        slot: result.slot,
        explorerUrl: explorerUrl(result.signature, config.cluster, config.rpcUrl),
      });
      setVersion((value) => value + 1);
    } catch (error) {
      setTx({ state: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const redeemAll: RedeemItem[] = model.redeemable.map(
    ({ market, yesAccounts, noAccounts, usdcAccount }) => ({
      market,
      yesAccounts,
      noAccounts,
      usdcAccount,
    }),
  );

  const portfolioTotals: PortfolioTotals = {
    usdcBalance: model.totals.usdc,
    redeemableNow: model.totals.redeemable, // already in USDC base units
    unrealizedCents: model.totals.unrealized, // already in USDC base units
    realizedCents: model.totals.realized, // already in USDC base units
  };

  return (
    <div className="flex flex-col gap-mer-4">
      <PortfolioFilters activeTab={filter} onTabChange={setFilter} totals={portfolioTotals} />
      {redeemAll.length > 0 ? (
        <div>
          <button
            type="button"
            className="rounded-mer border border-mer-control-border px-mer-2 py-mer-1 font-medium disabled:opacity-50"
            disabled={busy}
            onClick={() => void run((actions) => actions.redeem(redeemAll))}
          >
            Redeem all
          </button>
        </div>
      ) : null}
      {model.incompleteHistory ? (
        <p role="note" className="text-mer-sm text-mer-ink-muted">
          History incomplete: P&L is shown as — where the events on this wallet do not account for
          every contract held.
        </p>
      ) : null}
      {tx === null ? null : <TxStatus {...tx} />}

      {testMarketCount > 0 ? (
        <TestMarketToggle
          testMarketCount={testMarketCount}
          showTestMarkets={showTestMarkets}
          onToggle={() => setShowTestMarkets(!showTestMarkets)}
        />
      ) : null}
      {filter === "resting" ? (
        model.resting.length === 0 ? (
          <p>No resting orders.</p>
        ) : (
          <RestingTable model={model} />
        )
      ) : shown.length === 0 ? (
        <p>{filter === "open" ? "No open positions." : "No closed positions."}</p>
      ) : (
        <PositionsTable
          rows={shown}
          nowSecs={nowSecs}
          overrideDelaySecs={overrideDelaySecs}
          onRedeem={(market) => {
            const item = redeemAll.find((candidate) => candidate.market.address === market.address);
            if (item !== undefined) void run((actions) => actions.redeem([item]));
          }}
          busy={busy}
          firstUse={firstUseKeys(shown)}
        />
      )}

      <MmBlock
        mm={model.mm}
        busy={busy}
        onWithdraw={() => void run((actions) => actions.withdraw(model.mm.withdrawable))}
      />
    </div>
  );
}
