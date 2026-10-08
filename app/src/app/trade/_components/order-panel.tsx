"use client";

import type { Intent } from "@meridian/client";
import { useEffect, useMemo, useState } from "react";

import { levelsOf, type FullBook } from "../_lib/book-view";
import { gateFor, type Holdings } from "../_lib/constraint";
import {
  allowsLimit,
  INTENT_LABEL,
  INTENT_ORDER,
  intentSubLabel,
  parseOrder,
  signLabel,
  sideOf,
  startingPrice,
} from "../_lib/intents";
import type { PanelState } from "../_lib/state";
import { costStrip, FEE_NOTE, payoffSentence, simulationLine } from "../_lib/summary";
import type { TradeActions, TradeRequest } from "../_lib/tx";
import { useSimulation } from "./use-simulation";
import { SideLabel, TxStatus, type TxStatusProps, PayoffSentence } from "@/components/ui";
import { formatStrike, type MarketRow } from "@/lib/markets";
import { sideMeanings } from "../_lib/copy";

const control =
  "rounded-mer border border-mer-control-border bg-mer-surface px-mer-3 py-mer-2 text-mer-sm text-mer-ink";

const signButtonClass =
  "rounded-mer bg-mer-ink px-mer-4 py-mer-3 text-mer-md font-semibold text-mer-paper";

export const CONNECT_TO_SIMULATE = "Connect a wallet to see what you pay and win.";

type Props = {
  readonly market: MarketRow;
  readonly panel: PanelState;
  readonly book: FullBook | null;
  readonly holdings: Holdings;
  /** Base58 of the connected wallet, or `null`. */
  readonly user: string | null;
  readonly actions: TradeActions | null;
  readonly explorerUrl: (signature: string) => string;
  /** Called after a confirmed transaction so the page refreshes the book and balances. */
  readonly onConfirmed: () => void;
  readonly debounceMs?: number;
};

function IntentControl({
  panel,
  intent,
  strikeText,
  holdings,
  onSelect,
}: {
  readonly panel: PanelState;
  readonly intent: Intent;
  readonly strikeText: string;
  readonly holdings: Holdings;
  readonly onSelect: (intent: Intent) => void;
}) {
  const tradable = panel.tradable;
  return (
    <div
      role="radiogroup"
      aria-label="What do you want to do?"
      aria-describedby={tradable ? undefined : "panel-reason"}
      className="grid grid-cols-2 gap-mer-2 sm:grid-cols-4"
    >
      {INTENT_ORDER.map((value) => {
        const gate = gateFor(value, holdings);
        const selected = value === intent;
        const sub = gate.blocked
          ? `blocked: ${gate.kind === "hold-yes" ? "you hold YES" : gate.kind === "hold-no" ? "you hold NO" : "order resting"}`
          : intentSubLabel(value, strikeText);
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!tradable}
            title={gate.blocked ? gate.text : undefined}
            onClick={() => onSelect(value)}
            className={`flex min-h-12 flex-col items-center justify-center rounded-mer border px-mer-2 py-mer-2 text-mer-sm font-semibold disabled:opacity-60 ${
              selected
                ? "border-mer-ink bg-mer-ink text-mer-paper"
                : "border-mer-control-border bg-mer-surface text-mer-ink"
            }`}
          >
            <span>{INTENT_LABEL[value]}</span>
            <span className="text-mer-xs font-normal">{sub}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The sign button where there is nothing to sign: present, labelled and disabled. */
function DisabledSign({ intent }: { readonly intent: Intent }) {
  return (
    <div>
      <button type="button" disabled className={`${signButtonClass} disabled:opacity-50`}>
        {signLabel(intent)}
      </button>
    </div>
  );
}

/** The 4-intent panel: one form, one payoff sentence, one sign button (FR-17, NFR-12, NFR-15). */
export function OrderPanel(props: Props) {
  const { market, panel, book, holdings, user, actions, explorerUrl, onConfirmed } = props;
  const [intent, setIntent] = useState<Intent>("BUY_YES");
  const [kind, setKind] = useState<"limit" | "market">("limit");
  const [priceText, setPriceText] = useState("50");
  const [qtyText, setQtyText] = useState("10");
  const [tx, setTx] = useState<TxStatusProps | null>(null);
  const strikeText = formatStrike(market.strikeCents);
  const levels = useMemo(() => (book === null ? { bids: [], asks: [] } : levelsOf(book)), [book]);
  const gate = gateFor(intent, holdings);

  // Start each intent / kind with a sensible price (one that crosses the best opposite order).
  const selectIntent = (next: Intent, qty?: bigint): void => {
    setIntent(next);
    const nextKind = allowsLimit(next) ? kind : "market";
    setKind(nextKind);
    setPriceText(String(startingPrice(next, nextKind, levels)));
    if (qty !== undefined && qty > 0n) setQtyText(qty.toString());
    setTx(null);
  };
  const selectKind = (next: "limit" | "market"): void => {
    setKind(next);
    setPriceText(String(startingPrice(intent, next, levels)));
  };
  // The book is read after the first render; seed the price once it is known.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && book !== null) {
      setSeeded(true);
      setPriceText(String(startingPrice(intent, kind, levels)));
    }
  }, [seeded, book, intent, kind, levels]);

  const parsed = parseOrder(intent, { kind, priceText, qtyText });
  const request: TradeRequest | null =
    panel.tradable && !gate.blocked && parsed.ok && book !== null
      ? { intent, kind: parsed.kind, priceCents: parsed.priceCents, qty: parsed.qty, book }
      : null;
  const bookKey = useMemo(() => {
    if (book === null) return "";
    const flat = (side: FullBook["bids"]) =>
      side.map((o) => `${o.orderId}:${o.price}:${o.qty}`).join(",");
    return `${flat(book.bids)}/${flat(book.asks)}`;
  }, [book]);
  const sim = useSimulation(actions, request, user, bookKey, props.debounceMs);
  const busy = tx?.state === "awaiting-signature" || tx?.state === "confirming";
  const canSign = sim.status === "ok" && request !== null && !busy;

  async function sign(): Promise<void> {
    if (actions === null || request === null || sim.status !== "ok") return;
    setTx({ state: "awaiting-signature" });
    try {
      const result = await actions.trade(request, (phase) => setTx({ state: phase }));
      setTx({ state: "confirmed", slot: result.slot, explorerUrl: explorerUrl(result.signature) });
      onConfirmed();
    } catch (error) {
      setTx({
        state: "failed",
        reason:
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "the order was not sent",
      });
    }
  }

  const meanings = sideMeanings(market);
  const facts = { ticker: market.ticker, strikeCents: market.strikeCents };

  return (
    <section aria-labelledby="order-heading" className="grid gap-mer-4">
      <h2 id="order-heading" className="text-mer-lg font-semibold">
        Trade
      </h2>
      <IntentControl
        panel={panel}
        intent={intent}
        strikeText={strikeText}
        holdings={holdings}
        onSelect={(next) => selectIntent(next)}
      />
      <div className="grid gap-mer-1 text-mer-xs text-mer-ink-muted">
        <SideLabel side="YES" meaning={meanings.yes} />
        <SideLabel side="NO" meaning={meanings.no} />
      </div>

      {!panel.tradable ? (
        <div className="grid gap-mer-2">
          <p id="panel-reason" data-testid="panel-reason" className="text-mer-md font-medium">
            {panel.reason}
          </p>
          {panel.help === undefined ? null : (
            <p data-testid="panel-help" className="text-mer-sm text-mer-ink-muted">
              {panel.help}
            </p>
          )}
          <DisabledSign intent={intent} />
        </div>
      ) : gate.blocked ? (
        <>
          <div
            role="group"
            aria-label="Position constraint"
            data-testid="constraint-block"
            className="grid gap-mer-2 rounded-mer border border-mer-warn p-mer-3"
          >
            <p className="text-mer-md">{gate.text}</p>
            {gate.exit === null || gate.exitLabel === null ? null : (
              <div>
                <button
                  type="button"
                  className={`${control} font-semibold`}
                  onClick={() => selectIntent(gate.exit as Intent, gate.exitQty)}
                >
                  {gate.exitLabel}
                </button>
              </div>
            )}
          </div>
          <DisabledSign intent={intent} />
        </>
      ) : (
        <form
          className="grid gap-mer-3"
          onSubmit={(event) => {
            event.preventDefault();
            void sign();
          }}
        >
          <fieldset className="flex flex-wrap items-center gap-mer-3">
            <legend className="sr-only">Order type</legend>
            <label className="flex items-center gap-mer-1 text-mer-sm">
              <input
                type="radio"
                name="kind"
                checked={kind === "market"}
                onChange={() => selectKind("market")}
              />
              Market
            </label>
            <label className="flex items-center gap-mer-1 text-mer-sm">
              <input
                type="radio"
                name="kind"
                checked={kind === "limit"}
                disabled={!allowsLimit(intent)}
                onChange={() => selectKind("limit")}
              />
              Limit
            </label>
            {allowsLimit(intent) ? null : (
              <span className="text-mer-xs text-mer-ink-muted">
                Sell NO fills now or not at all; the price is your worst price.
              </span>
            )}
          </fieldset>
          <div className="flex flex-wrap items-end gap-mer-3">
            <label className="grid gap-mer-1 text-mer-sm">
              {kind === "limit" ? "Price" : "Worst price"} (¢ {sideOf(intent)})
              <input
                className={`${control} mer-num w-28`}
                inputMode="numeric"
                value={priceText}
                onChange={(event) => setPriceText(event.target.value)}
              />
            </label>
            <label className="grid gap-mer-1 text-mer-sm">
              Quantity (contracts)
              <input
                className={`${control} mer-num w-28`}
                inputMode="numeric"
                value={qtyText}
                onChange={(event) => setQtyText(event.target.value)}
              />
            </label>
          </div>
          {parsed.ok ? null : (
            <p role="alert" className="text-mer-sm text-mer-loss">
              {parsed.message}
            </p>
          )}

          {sim.status === "ok" ? (
            <div className="grid gap-mer-2" data-testid="simulated">
              <PayoffSentence>{payoffSentence(sim.summary, facts)}</PayoffSentence>
              <dl className="flex flex-wrap gap-x-mer-4 gap-y-mer-1" data-testid="cost-strip">
                {costStrip(sim.summary).map((item) => (
                  <div key={item.label} className="flex gap-mer-1 text-mer-sm">
                    <dt className="text-mer-ink-muted">{item.label}</dt>
                    <dd className="mer-num font-medium">{item.value}</dd>
                    {item.label === "Fees" ? (
                      <dd className="text-mer-xs text-mer-ink-muted">({FEE_NOTE})</dd>
                    ) : null}
                  </div>
                ))}
              </dl>
              <p className="text-mer-sm" data-testid="simulation-line">
                {simulationLine(sim.summary)}
              </p>
            </div>
          ) : sim.status === "idle" && user === null ? (
            <p className="text-mer-sm text-mer-ink-muted">{CONNECT_TO_SIMULATE}</p>
          ) : null}

          <div>
            <button
              type="submit"
              disabled={!canSign}
              className={`${signButtonClass} disabled:opacity-50`}
            >
              {signLabel(intent)}
            </button>
          </div>
          {sim.status === "simulating" ? <TxStatus state="simulating" /> : null}
          {sim.status === "failed" ? <TxStatus state="failed" reason={sim.reason} /> : null}
          {tx === null ? null : <TxStatus {...tx} />}
        </form>
      )}
    </section>
  );
}
