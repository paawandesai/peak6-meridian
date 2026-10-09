"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useMemo, useState } from "react";

import {
  ACTION_BY_KIND,
  ALL,
  buildRows,
  filterRows,
  type HistoryAction,
  type HistoryRow,
} from "./history-model";
import { Cents } from "@/components/ui";
import type { MeridianEvent } from "@/lib/events";
import type { MarketRow } from "@/lib/markets";

export const CONNECT_TEXT = "Connect a wallet to see your history.";
export const EMPTY_TEXT = "No activity yet for this wallet.";
export const NO_MATCH_TEXT = "No events match these filters.";

const ACTIONS: readonly HistoryAction[] = [...new Set(Object.values(ACTION_BY_KIND))];
const FIELD =
  "min-h-11 rounded-mer border border-mer-border bg-mer-paper px-mer-2 text-mer-sm text-mer-ink";

export function HistoryTable({
  rows,
  explorerUrl,
}: {
  readonly rows: readonly HistoryRow[];
  readonly explorerUrl: (signature: string) => string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-mer-sm">
        <caption className="sr-only">Wallet history, newest first. Times are Eastern Time.</caption>
        <thead>
          <tr className="text-left text-mer-ink-muted">
            <th scope="col" className="py-mer-1 pr-mer-3 font-medium">
              Time (ET)
            </th>
            <th scope="col" className="py-mer-1 pr-mer-3 font-medium">
              Market
            </th>
            <th scope="col" className="py-mer-1 pr-mer-3 font-medium">
              Action
            </th>
            <th scope="col" className="py-mer-1 pr-mer-3 font-medium">
              Side
            </th>
            <th scope="col" className="py-mer-1 pr-mer-3 text-right font-medium">
              Price
            </th>
            <th scope="col" className="py-mer-1 pr-mer-3 text-right font-medium">
              Qty
            </th>
            <th scope="col" className="py-mer-1 pr-mer-3 font-medium">
              Detail
            </th>
            <th scope="col" className="py-mer-1 font-medium">
              Transaction
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-mer-border align-top">
              <td className="mer-num py-mer-1 pr-mer-3 whitespace-nowrap">{row.timeEt}</td>
              <td className="py-mer-1 pr-mer-3">{row.market}</td>
              <td className="py-mer-1 pr-mer-3">{row.action}</td>
              <td className="py-mer-1 pr-mer-3">{row.side}</td>
              <td className="py-mer-1 pr-mer-3 text-right">
                {row.priceCents === null ? (
                  "—"
                ) : (
                  <Cents cents={row.priceCents} showPercent={false} />
                )}
              </td>
              <td className="mer-num py-mer-1 pr-mer-3 text-right">{row.qty?.toString() ?? "—"}</td>
              <td className="py-mer-1 pr-mer-3 text-mer-ink-muted">{row.detail}</td>
              <td className="py-mer-1">
                <a
                  href={explorerUrl(row.signature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`View transaction ${row.signature} in the explorer`}
                  className="mer-num rounded-mer underline underline-offset-4"
                >
                  {row.signature.slice(0, 8)}…
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Newest-first event list for the connected wallet with market and action filters. */
export function HistoryView({
  events,
  markets,
  explorerUrl,
}: {
  readonly events: readonly MeridianEvent[];
  readonly markets: readonly MarketRow[];
  readonly explorerUrl: (signature: string) => string;
}) {
  const { publicKey } = useWallet();
  const [market, setMarket] = useState(ALL);
  const [action, setAction] = useState(ALL);
  const wallet = publicKey?.toBase58() ?? null;
  const rows = useMemo(
    () => buildRows(events, wallet ?? "", new Map(markets.map((row) => [row.address, row]))),
    [events, markets, wallet],
  );
  if (wallet === null) return <p>{CONNECT_TEXT}</p>;
  if (rows.length === 0) return <p>{EMPTY_TEXT}</p>;
  const marketOptions = [...new Map(rows.map((row) => [row.marketAddress, row.market]))];
  const shown = filterRows(rows, market, action);
  return (
    <div className="flex flex-col gap-mer-3">
      <div className="flex flex-wrap gap-mer-3">
        <label className="flex flex-col text-mer-xs text-mer-ink-muted">
          Market
          <select className={FIELD} value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value={ALL}>All markets</option>
            {marketOptions.map(([address, label]) => (
              <option key={address} value={address}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-mer-xs text-mer-ink-muted">
          Action
          <select className={FIELD} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value={ALL}>All actions</option>
            {ACTIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {shown.length === 0 ? (
        <p>{NO_MATCH_TEXT}</p>
      ) : (
        <HistoryTable rows={shown} explorerUrl={explorerUrl} />
      )}
      <p className="text-mer-xs text-mer-ink-muted">
        Prices are on the YES book: Buy NO appears as its Sell YES leg. Times are Eastern Time.
      </p>
    </div>
  );
}
