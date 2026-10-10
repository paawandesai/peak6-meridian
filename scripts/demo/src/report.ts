/** Plain-text summaries printed by the two CLIs (no secrets: addresses and signatures only). */
import { centsToDecimal } from "./closes";
import { formatEt } from "./dates";
import { type DemoMarketsReport } from "./markets";
import { type DemoSettleReport } from "./settle";

/** A left-aligned text table. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

const dollars = (cents: number | bigint): string => `$${centsToDecimal(Number(cents))}`;

export function formatMarketsReport(report: DemoMarketsReport, dryRun: boolean): string {
  const { session } = report;
  const counts = new Map<string, number>();
  for (const row of report.rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const header = [
    `${dryRun ? "DRY RUN · " : ""}DEMO session ${report.tradingDate} (non-trading day)`,
    `  simulates the ${report.asOf} session · strikes from the ${report.prevDate} closes`,
    `  trading closes ${formatEt(report.closeTs)} (close_ts ${String(report.closeTs)})`,
  ];
  const perTicker = table(
    ["ticker", "basis close", "AS_OF close", "strikes"],
    session.tickers.map((t) => [
      t,
      dollars(session.prevCloseCentsByTicker?.[t] ?? 0),
      session.asOfCloseCentsByTicker[t] === undefined
        ? "unknown"
        : dollars(session.asOfCloseCentsByTicker[t]),
      (session.strikesByTicker[t] ?? []).map((s) => dollars(s)).join(" "),
    ]),
  );
  const markets = table(
    ["ticker", "strike", "status", "signature"],
    report.rows.map((r) => [r.ticker, dollars(r.strikeCents), r.status, r.signature ?? ""]),
  );
  const summary = [...counts].map(([status, n]) => `${String(n)} ${status}`).join(", ");
  const foreign =
    report.foreignMarkets === 0
      ? []
      : [
          `WARNING: ${String(report.foreignMarkets)} other market(s) already on ${report.tradingDate} ` +
            "are not part of this session (they keep their own strikes and close)",
        ];
  return [...header, "", perTicker, "", markets, "", `markets: ${summary}`, ...foreign].join("\n");
}

export function formatSettleReport(report: DemoSettleReport, dryRun: boolean): string {
  const header = `${dryRun ? "DRY RUN · " : ""}DEMO settle ${report.tradingDate} at the ${report.asOf} closes`;
  if (report.rows.length === 0) {
    return `${header}\nno open markets on ${report.tradingDate}: nothing to settle`;
  }
  const rows = table(
    ["ticker", "strike", "price", "outcome", "status", "detail"],
    report.rows.map((r) => [
      r.market.ticker,
      dollars(r.market.strikeCents),
      r.priceCents === undefined ? "-" : dollars(r.priceCents),
      r.outcome ?? "-",
      r.status,
      r.detail,
    ]),
  );
  const early = report.rows.filter((r) => r.status === "too early").map((r) => r.allowedFromTs);
  const tail =
    early.length === 0
      ? []
      : [
          "",
          `too early: the override is allowed from ${formatEt(Math.max(...early))}; re-run then`,
        ];
  return [header, "", rows, ...tail].join("\n");
}
