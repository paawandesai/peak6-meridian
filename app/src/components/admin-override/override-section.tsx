"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";

import { type Draft, fetchDrafts, PENDING_STATUS } from "./drafts";
import type { OverrideActions } from "./override-chain";
import { approveState, bpsText, money, sourceAge, withinSourceRange } from "./override-rules";
import { loadRejected, saveRejected } from "./rejected";
import { useReader } from "@/components/reader-context";
import { TxStatus, type TxStatusProps } from "@/components/ui";
import { useAsync } from "@/components/use-async";
import { formatStrike, formatTradingDate, type MarketRow } from "@/lib/markets";

const button =
  "rounded-mer border border-mer-control-border bg-mer-surface px-mer-3 py-mer-2 text-mer-sm font-semibold disabled:opacity-50";

export const EMPTY_TEXT = "No pending decisions.";

type Props = {
  /** `null` until the clock has mounted. */
  readonly nowSecs: number | null;
  readonly actions: OverrideActions;
  readonly explorerUrl: (signature: string) => string;
  /** Defaults to the `/api/ops/drafts` proxy; injectable for tests. */
  readonly loadDrafts?: () => Promise<Draft[]>;
};

function DraftCard({
  draft,
  market,
  nowSecs,
  config,
  actions,
  explorerUrl,
  onReject,
  onSettled,
}: {
  readonly draft: Draft;
  readonly market: MarketRow | undefined;
  readonly nowSecs: number;
  readonly config: {
    readonly paused: boolean;
    readonly overrideDelaySecs: bigint;
    readonly admin: string;
  };
  readonly actions: OverrideActions;
  readonly explorerUrl: (signature: string) => string;
  readonly onReject: () => void;
  readonly onSettled: () => void;
}) {
  const [tx, setTx] = useState<TxStatusProps | null>(null);
  const state = approveState(market, config, nowSecs);
  const busy = tx?.state === "awaiting-signature" || tx?.state === "confirming";
  const id = `draft-${draft.incident_id}`;

  async function approve(): Promise<void> {
    setTx({ state: "awaiting-signature" });
    try {
      const result = await actions.approve(draft.market, BigInt(draft.proposed_price_cents));
      setTx({ state: "confirmed", slot: result.slot, explorerUrl: explorerUrl(result.signature) });
      onSettled();
    } catch (error) {
      setTx({
        state: "failed",
        reason:
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "the override was not sent",
      });
    }
  }

  return (
    <li
      className="grid gap-mer-3 rounded-mer border border-mer-control-border p-mer-4"
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`} className="text-mer-md font-semibold">
        {market === undefined
          ? `Unknown market ${draft.market.slice(0, 8)}…`
          : `${market.ticker} ${formatStrike(market.strikeCents)} · ${formatTradingDate(market.tradingDate)}`}
      </h3>
      <p className="text-mer-md">
        Proposed settle price{" "}
        <span className="mer-num font-semibold">{money(draft.proposed_price_cents)}</span>
        {withinSourceRange(draft) ? null : (
          <span className="text-mer-warn"> (outside the range of the source closes)</span>
        )}
      </p>
      <table className="w-full text-mer-sm">
        <caption className="pb-mer-1 text-left text-mer-xs text-mer-ink-muted">Evidence</caption>
        <thead>
          <tr className="text-left text-mer-ink-muted">
            <th scope="col" className="py-0.5 font-medium">
              Source
            </th>
            <th scope="col" className="py-0.5 font-medium">
              Close
            </th>
            <th scope="col" className="py-0.5 font-medium">
              Staleness
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.sources.map((source) => (
            <tr key={source.name}>
              <th scope="row" className="py-0.5 text-left font-normal">
                {source.name}
              </th>
              <td className="mer-num py-0.5">{money(source.close)}</td>
              <td className="py-0.5 text-mer-ink-muted">{sourceAge(source.as_of, nowSecs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-mer-sm">
        Spread between sources: <span className="mer-num">{bpsText(draft.spread_bps)}</span>
      </p>
      <p className="whitespace-pre-wrap text-mer-sm text-mer-ink-muted" data-testid="draft-note">
        {draft.note}
      </p>
      <p className="text-mer-sm font-medium" data-testid="availability">
        {state.availability}
      </p>
      <div className="flex flex-wrap gap-mer-3">
        <button
          type="button"
          className={button}
          disabled={!state.enabled || busy}
          aria-describedby={state.enabled ? undefined : `${id}-why`}
          onClick={() => void approve()}
        >
          Approve
        </button>
        <button type="button" className={button} disabled={busy} onClick={onReject}>
          Reject
        </button>
      </div>
      {state.enabled ? null : (
        <p id={`${id}-why`} className="text-mer-xs text-mer-ink-muted">
          {state.reason}
        </p>
      )}
      {tx === null ? null : <TxStatus {...tx} />}
    </li>
  );
}

/**
 * "Pending decisions" (FR-28, UI-08 AC1): the ops-agent's override drafts with their evidence,
 * shown only to the wallet equal to `Config.admin`. Approve builds `admin_settle_override` for
 * that wallet (one signature) and is disabled until `close_ts + override_delay_secs`; Reject
 * hides the draft here. Nothing is signed server-side.
 */
export function OverrideSection({
  nowSecs,
  actions,
  explorerUrl,
  loadDrafts = fetchDrafts,
}: Props) {
  const reader = useReader();
  const { publicKey } = useWallet();
  const [version, setVersion] = useState(0);
  const config = useAsync(() => reader.getConfig(), [reader]);
  const markets = useAsync(() => reader.listMarkets(), [reader, version]);
  const isAdmin =
    publicKey !== null && config.status === "ready" && config.value.admin === publicKey.toBase58();
  // Drafts are fetched only for the admin wallet, so no one else triggers the proxy from here.
  const drafts = useAsync(
    () => (isAdmin ? loadDrafts() : Promise.resolve([] as Draft[])),
    [isAdmin, version],
  );
  const [rejected, setRejected] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setRejected(loadRejected(typeof window === "undefined" ? undefined : window.localStorage));
  }, []);
  const byAddress = useMemo(
    () => new Map((markets.status === "ready" ? markets.value : []).map((m) => [m.address, m])),
    [markets],
  );

  if (!isAdmin || config.status !== "ready") return null;

  const reject = (incidentId: string): void => {
    const next = new Set(rejected).add(incidentId);
    setRejected(next);
    saveRejected(typeof window === "undefined" ? undefined : window.localStorage, next);
  };
  const pending =
    drafts.status === "ready"
      ? drafts.value.filter((d) => d.status === PENDING_STATUS && !rejected.has(d.incident_id))
      : [];

  return (
    <section aria-labelledby="pending-heading" className="mb-mer-8 grid gap-mer-3">
      <h2 id="pending-heading" className="text-mer-lg font-semibold">
        Pending decisions
      </h2>
      <p className="text-mer-sm text-mer-ink-muted">
        Override drafts from the ops agent. You approve in your own wallet; the program only accepts
        an override from the admin, after the delay.
      </p>
      {drafts.status === "loading" || markets.status === "loading" || nowSecs === null ? (
        <p role="status">Loading pending decisions…</p>
      ) : drafts.status === "error" ? (
        <p role="alert">Could not load drafts: {drafts.message}</p>
      ) : markets.status === "error" ? (
        <p role="alert">Could not read the markets: {markets.message}</p>
      ) : pending.length === 0 ? (
        <p>{EMPTY_TEXT}</p>
      ) : (
        <ul className="grid gap-mer-4">
          {pending.map((draft) => (
            <DraftCard
              key={draft.incident_id}
              draft={draft}
              market={byAddress.get(draft.market)}
              nowSecs={nowSecs}
              config={config.value}
              actions={actions}
              explorerUrl={explorerUrl}
              onReject={() => reject(draft.incident_id)}
              onSettled={() => setVersion((v) => v + 1)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
