import type { ReactNode } from "react";

import { formatUsdcBalance } from "@/lib/display";
import { formatStrike, formatTradingDate } from "@/lib/markets";
import {
  BOOK_COVERAGE_TEXT,
  buildDays,
  formatEtStamp,
  marketStatusRow,
  slotsToSecs,
  type DayLiveness,
  type MarketStatusRow,
  NO_FACTS,
  type Verdict,
} from "@/lib/status";
import type { StatusData } from "./status-chain";

export const EMPTY_TEXT = "No markets yet.";
const UNAVAILABLE = "unavailable";

/** Pass/Fail always carries its word and a glyph; colour only reinforces it. */
export function VerdictBadge({ verdict }: { readonly verdict: Verdict }) {
  const pass = verdict === "Pass";
  return (
    <span
      className={`inline-flex items-center gap-mer-1 font-semibold ${pass ? "text-mer-gain" : "text-mer-loss"}`}
    >
      <span aria-hidden="true">{pass ? "✓" : "✕"}</span>
      {verdict}
    </span>
  );
}

const et = (unix: number | null) => (unix === null ? UNAVAILABLE : formatEtStamp(unix));

function delayText(secs: number | null): string {
  if (secs === null) return UNAVAILABLE;
  const abs = Math.abs(secs);
  const text = `${Math.floor(abs / 60)} min ${abs % 60} s`;
  return secs >= 0 ? `${text} after close` : `${text} before close`;
}

function ageText(slots: bigint | null): string {
  return slots === null ? UNAVAILABLE : `${slots} slots (about ${slotsToSecs(slots)} s)`;
}

const TH = "py-mer-1 pr-mer-3 text-left font-medium";
const TD = "py-mer-1 pr-mer-3 align-top";

function marketName(row: MarketStatusRow): string {
  return `${row.market.ticker} ≥ ${formatStrike(row.market.strikeCents)}`;
}

function Invariants({ rows }: { readonly rows: readonly MarketStatusRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-mer-sm">
        <caption className="sr-only">Vault balance against pairs outstanding times $1</caption>
        <thead className="text-mer-ink-muted">
          <tr>
            <th scope="col" className={TH}>
              Market
            </th>
            <th scope="col" className={TH}>
              Pairs outstanding
            </th>
            <th scope="col" className={TH}>
              Expected vault
            </th>
            <th scope="col" className={TH}>
              Actual vault
            </th>
            <th scope="col" className={TH}>
              Invariant
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.market.address} className="border-t border-mer-rule">
              <th scope="row" className={`${TD} font-normal`}>
                {marketName(row)}
              </th>
              <td className={`${TD} mer-num`}>{row.market.pairsOutstanding.toString()}</td>
              <td className={`${TD} mer-num`}>{formatUsdcBalance(row.invariant.expected)}</td>
              <td className={`${TD} mer-num`}>
                {row.invariant.actual === null
                  ? UNAVAILABLE
                  : formatUsdcBalance(row.invariant.actual)}
              </td>
              <td className={TD}>
                <VerdictBadge verdict={row.invariant.verdict} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Settlement({ rows }: { readonly rows: readonly MarketStatusRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-mer-sm">
        <caption className="sr-only">Settlement detail per market</caption>
        <thead className="text-mer-ink-muted">
          <tr>
            <th scope="col" className={TH}>
              Market
            </th>
            <th scope="col" className={TH}>
              Created (ET)
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
            <th scope="col" className={TH}>
              Settled (ET)
            </th>
            <th scope="col" className={TH}>
              Delay after close
            </th>
            <th scope="col" className={TH}>
              Oracle age
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.market.address} className="border-t border-mer-rule">
              <th scope="row" className={`${TD} font-normal`}>
                {marketName(row)}
              </th>
              <td className={`${TD} mer-num`}>{et(row.createdAt)}</td>
              <td className={TD}>
                {row.market.settled ? `Settled ${row.market.outcome.toUpperCase()}` : "Not settled"}
                {" · "}
                {row.settlement}
              </td>
              <td className={`${TD} mer-num`}>{row.market.settled ? et(row.settledAt) : "—"}</td>
              <td className={TD}>{row.market.settled ? delayText(row.settleDelaySecs) : "—"}</td>
              <td className={TD}>{row.market.settled ? ageText(row.oracleAgeSlots) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Metric({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-mer-xs text-mer-ink-muted">{label}</dt>
      <dd className="text-mer-sm">{children}</dd>
    </div>
  );
}

function Day({ day }: { readonly day: DayLiveness }) {
  const heading = `status-day-${day.tradingDate}`;
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-mer-3">
      <h3 id={heading} className="text-mer-lg font-semibold">
        {formatTradingDate(day.tradingDate)}
      </h3>
      <dl className="grid gap-mer-3 sm:grid-cols-3">
        <Metric label="Markets created vs 09:00 ET">
          <VerdictBadge verdict={day.creation} />{" "}
          <span className="mer-num">
            last created {et(day.lastCreatedAt)}; deadline {formatEtStamp(day.creationDeadline)};{" "}
            {day.createdKnown} of {day.rows.length} known
          </span>
        </Metric>
        <Metric label="Settled vs close">
          {day.settledCount} of {day.rows.length} settled; slowest{" "}
          {delayText(day.worstSettleDelaySecs)}
        </Metric>
        <Metric label="Oracle age at settle">oldest {ageText(day.maxOracleAgeSlots)}</Metric>
      </dl>
      <h4 className="text-mer-md font-semibold">Vault invariant</h4>
      <Invariants rows={day.rows} />
      <h4 className="text-mer-md font-semibold">Settlement detail</h4>
      <Settlement rows={day.rows} />
    </section>
  );
}

/** Read-only /status body: no wallet needed. */
export function StatusView({ data }: { readonly data: StatusData }) {
  if (data.markets.length === 0) return <p>{EMPTY_TEXT}</p>;
  const rows = data.markets.map((market) =>
    marketStatusRow(
      market,
      data.vaults.get(market.address) ?? null,
      data.facts.get(market.address) ?? NO_FACTS,
    ),
  );
  const days = buildDays(rows);
  return (
    <div className="flex flex-col gap-mer-6">
      <p className="text-mer-sm text-mer-ink-muted">
        Vault must equal pairs outstanding × $1.00 exactly. {BOOK_COVERAGE_TEXT}. Times are Eastern
        Time; oracle age counts slots between the oracle reading and the settle transaction.
      </p>
      {days.map((day) => (
        <Day key={day.tradingDate} day={day} />
      ))}
    </div>
  );
}
