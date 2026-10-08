"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";

import { TxStatus, type TxStatusProps } from "./ui";
import { useAsync } from "./use-async";
import { useReader } from "./reader-context";
import {
  adminErrorText,
  PAUSE_KEEPS,
  PAUSE_STOPS,
  TICKERS,
  UNPAUSE_RESUMES,
  validateAddStrike,
} from "@/lib/admin";
import type { AdminActions } from "@/lib/admin-chain";
import type { AppConfig } from "@/lib/chain";
import type { MarketRow } from "@/lib/markets";

export const NOT_ADMIN_TEXT = "Admin actions are available only to the admin wallet.";
export const CONNECT_TEXT = "Connect the admin wallet to see admin actions.";

const control =
  "rounded-mer border border-mer-control-border bg-mer-surface px-mer-3 py-mer-2 text-mer-sm";
const button = `${control} font-semibold disabled:opacity-50`;

/** Tracks one transaction's line (`TxStatus`) around an admin action. */
function useTx(explorerUrl: (signature: string) => string) {
  const [tx, setTx] = useState<TxStatusProps | null>(null);
  async function run(
    action: () => Promise<{ readonly signature: string; readonly slot: number }>,
  ): Promise<boolean> {
    setTx({ state: "awaiting-signature" });
    try {
      const result = await action();
      setTx({ state: "confirmed", slot: result.slot, explorerUrl: explorerUrl(result.signature) });
      return true;
    } catch (error) {
      setTx({ state: "failed", reason: adminErrorText(error) });
      return false;
    }
  }
  return { tx, run, busy: tx?.state === "awaiting-signature" || tx?.state === "confirming" };
}

function PauseSection({
  config,
  actions,
  explorerUrl,
  onChanged,
}: {
  readonly config: AppConfig;
  readonly actions: AdminActions;
  readonly explorerUrl: (signature: string) => string;
  readonly onChanged: () => void;
}) {
  const { tx, run, busy } = useTx(explorerUrl);
  const next = !config.paused;
  return (
    <section aria-labelledby="pause-heading" className="grid gap-mer-3">
      <h2 id="pause-heading" className="text-mer-lg font-semibold">
        Pause
      </h2>
      <p className="text-mer-sm" data-testid="pause-state">
        {config.paused ? "Trading is paused." : "Trading is running."}
      </p>
      <p className="text-mer-sm">{PAUSE_STOPS}</p>
      <p className="text-mer-sm">{PAUSE_KEEPS}</p>
      {config.paused ? <p className="text-mer-sm">{UNPAUSE_RESUMES}</p> : null}
      <div>
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void run(() => actions.setPaused(next)).then((ok) => ok && onChanged())}
        >
          {config.paused ? "Unpause trading" : "Pause trading"}
        </button>
      </div>
      {tx === null ? null : <TxStatus {...tx} />}
    </section>
  );
}

function AddStrikeSection({
  markets,
  nowSecs,
  actions,
  explorerUrl,
  onChanged,
}: {
  readonly markets: readonly MarketRow[];
  readonly nowSecs: number;
  readonly actions: AdminActions;
  readonly explorerUrl: (signature: string) => string;
  readonly onChanged: () => void;
}) {
  const [ticker, setTicker] = useState<string>(TICKERS[0]);
  const [strikeText, setStrikeText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { tx, run, busy } = useTx(explorerUrl);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const check = validateAddStrike({ ticker, strikeText, markets, nowSecs });
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setError(null);
    void run(() => actions.addStrike(check.params)).then((ok) => {
      if (ok) {
        setStrikeText("");
        onChanged();
      }
    });
  }

  return (
    <section aria-labelledby="strike-heading" className="grid gap-mer-3">
      <h2 id="strike-heading" className="text-mer-lg font-semibold">
        Add strike
      </h2>
      <p className="text-mer-sm text-mer-ink-muted">
        Creates one more strike for today. It closes with today&apos;s other markets.
      </p>
      <form onSubmit={submit} className="grid gap-mer-3 sm:max-w-sm" noValidate>
        <label className="grid gap-mer-1 text-mer-sm">
          Ticker
          <select className={control} value={ticker} onChange={(e) => setTicker(e.target.value)}>
            {TICKERS.map((symbol) => (
              <option key={symbol} value={symbol}>
                {symbol}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-mer-1 text-mer-sm">
          Strike (USD, multiple of $10)
          <input
            className={`${control} mer-num`}
            inputMode="numeric"
            value={strikeText}
            onChange={(e) => setStrikeText(e.target.value)}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : "strike-error"}
          />
        </label>
        {error === null ? null : (
          <p id="strike-error" role="alert" className="text-mer-sm text-mer-loss">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className={button} disabled={busy}>
            Add strike
          </button>
        </div>
      </form>
      {tx === null ? null : <TxStatus {...tx} />}
    </section>
  );
}

/**
 * `/admin` (FR-28, UI-08): shown only to the wallet equal to `Config.admin`. Everyone else sees
 * one sentence and no controls. The program enforces the same rule (AB-06).
 */
export function AdminView({
  actions,
  explorerUrl,
  nowSecs,
}: {
  readonly actions: AdminActions;
  readonly explorerUrl: (signature: string) => string;
  /** `null` until the clock has mounted. */
  readonly nowSecs: number | null;
}) {
  const reader = useReader();
  const { publicKey } = useWallet();
  const [version, setVersion] = useState(0);
  const config = useAsync(() => reader.getConfig(), [reader, version]);
  const markets = useAsync(() => reader.listMarkets(), [reader, version]);
  const refresh = () => setVersion((v) => v + 1);

  if (publicKey === null) return <p>{CONNECT_TEXT}</p>;
  if (config.status === "loading") return <p role="status">Loading…</p>;
  if (config.status === "error")
    return <p role="alert">Could not read the config: {config.message}</p>;
  if (config.value.admin !== publicKey.toBase58()) return <p>{NOT_ADMIN_TEXT}</p>;

  return (
    <div className="grid gap-mer-8">
      <PauseSection
        config={config.value}
        actions={actions}
        explorerUrl={explorerUrl}
        onChanged={refresh}
      />
      {markets.status === "ready" && nowSecs !== null ? (
        <AddStrikeSection
          markets={markets.value}
          nowSecs={nowSecs}
          actions={actions}
          explorerUrl={explorerUrl}
          onChanged={refresh}
        />
      ) : (
        <p role="status">Loading markets…</p>
      )}
    </div>
  );
}
