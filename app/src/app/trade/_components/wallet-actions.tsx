"use client";

import { useState } from "react";

import { type BookOrder } from "../_lib/book-view";
import type { AllowedActions } from "../_lib/state";
import type { OnPhase, SubmitResult, TradeActions } from "../_lib/tx";
import type { WalletView } from "../_lib/reader";
import { TxStatus, type TxStatusProps } from "@/components/ui";
import { formatUsdCents, formatUsdcBalance } from "@/lib/display";
import type { MarketRow } from "@/lib/markets";

const button =
  "rounded-mer border border-mer-control-border bg-mer-surface px-mer-3 py-mer-2 text-mer-sm font-semibold disabled:opacity-50";

export type OwnOrder = BookOrder & { readonly side: "Bid" | "Ask" };

type Props = {
  readonly market: MarketRow;
  readonly allow: AllowedActions;
  readonly wallet: WalletView | null;
  readonly ownOrders: readonly OwnOrder[];
  readonly actions: TradeActions | null;
  readonly explorerUrl: (signature: string) => string;
  readonly onConfirmed: () => void;
};

/**
 * What still works when trading does not (design.md §3 action matrix) plus the everyday
 * recovery actions: Cancel on resting orders, Withdraw of free balances, pair Redeem when the
 * wallet holds both sides, and winner Redeem after settlement. A control is shown only when it
 * applies to this wallet. Each is one transaction and one signature.
 */
export function WalletActions({
  market,
  allow,
  wallet,
  ownOrders,
  actions,
  explorerUrl,
  onConfirmed,
}: Props) {
  const [tx, setTx] = useState<TxStatusProps | null>(null);
  const busy = tx?.state === "awaiting-signature" || tx?.state === "confirming";
  if (wallet === null && ownOrders.length === 0) return null;

  async function run(action: (onPhase: OnPhase) => Promise<SubmitResult>): Promise<void> {
    setTx({ state: "awaiting-signature" });
    try {
      const result = await action((phase) => setTx({ state: phase }));
      setTx({ state: "confirmed", slot: result.slot, explorerUrl: explorerUrl(result.signature) });
      onConfirmed();
    } catch (error) {
      setTx({
        state: "failed",
        reason:
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "the transaction was not sent",
      });
    }
  }

  const yes = wallet?.yes ?? 0n;
  const no = wallet?.no ?? 0n;
  const pairs = yes < no ? yes : no;
  const winning = market.outcome === "Yes" ? yes : no;
  const losing = market.outcome === "Yes" ? no : yes;
  const losingSide = market.outcome === "Yes" ? "NO" : "YES";
  const hasFree = wallet !== null && (wallet.freeUsdc > 0n || wallet.freeYes > 0n);

  const items: React.ReactNode[] = [];
  if (allow.cancel) {
    for (const order of ownOrders) {
      items.push(
        <li key={`cancel-${order.orderId}`} className="flex flex-wrap items-center gap-mer-3">
          <span className="text-mer-sm">
            Resting YES {order.side === "Bid" ? "bid" : "ask"}: {order.qty.toString()} at{" "}
            {order.price}¢
          </span>
          <button
            type="button"
            className={button}
            disabled={busy || actions === null}
            onClick={() =>
              void run((onPhase) => (actions as TradeActions).cancel(order.orderId, onPhase))
            }
          >
            Cancel
          </button>
        </li>,
      );
    }
  }
  if (allow.withdraw && hasFree && wallet !== null) {
    const parts = [
      wallet.freeUsdc > 0n ? formatUsdcBalance(wallet.freeUsdc) : null,
      wallet.freeYes > 0n ? `${wallet.freeYes} YES` : null,
    ].filter((part) => part !== null);
    items.push(
      <li key="withdraw" className="flex flex-wrap items-center gap-mer-3">
        <span className="text-mer-sm">Free balance: {parts.join(" and ")}</span>
        <button
          type="button"
          className={button}
          disabled={busy || actions === null}
          onClick={() => void run((onPhase) => (actions as TradeActions).withdraw(onPhase))}
        >
          Withdraw
        </button>
      </li>,
    );
  }
  if (allow.pairRedeem && pairs > 0n) {
    items.push(
      <li key="pair" className="flex flex-wrap items-center gap-mer-3">
        <span className="text-mer-sm">You hold {pairs.toString()} YES and NO pairs.</span>
        <button
          type="button"
          className={button}
          disabled={busy || actions === null}
          onClick={() =>
            void run((onPhase) => (actions as TradeActions).redeemPair(pairs, onPhase))
          }
        >
          Redeem {pairs.toString()} {pairs === 1n ? "pair" : "pairs"} for{" "}
          {formatUsdCents(pairs * 100n)}
        </button>
      </li>,
    );
  }
  if (allow.winnerRedeem) {
    if (winning > 0n) {
      items.push(
        <li key="winner" className="flex flex-wrap items-center gap-mer-3">
          <span className="text-mer-sm">Your winning tokens pay $1.00 each.</span>
          <button
            type="button"
            className={button}
            disabled={busy || actions === null}
            onClick={() =>
              void run((onPhase) => (actions as TradeActions).redeemWinner(yes, no, onPhase))
            }
          >
            Redeem {formatUsdCents(winning * 100n)}
          </button>
        </li>,
      );
    }
    if (losing > 0n) {
      items.push(
        <li key="losing" className="text-mer-sm">
          Your {losing.toString()} {losingSide} pay $0.00.
        </li>,
      );
    }
  }
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="actions-heading" className="grid gap-mer-2">
      <h2 id="actions-heading" className="text-mer-lg font-semibold">
        Your orders and balances
      </h2>
      <ul className="grid gap-mer-2">{items}</ul>
      {tx === null ? null : <TxStatus {...tx} />}
    </section>
  );
}
