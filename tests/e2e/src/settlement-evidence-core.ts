/**
 * Friday's recorded settlement (M3-09 AC2): from a market's `MarketSettled` event and its close
 * time, the settlement latency against the 10-minute budget, plus the explorer links and the
 * `docs/log.md` rows. Pure; the RPC reads live in `settlement-evidence.ts`.
 */

/** requirements.md: settlement latency ≤ 10 min (`settled_ts − close_ts`). */
export const SETTLEMENT_BUDGET_SECS = 10 * 60;

export type SettlementRow = {
  readonly label: string;
  readonly market: string;
  readonly closeTs: number;
  /** Block time of the settle transaction, `null` when the cluster reported none. */
  readonly settledAt: number | null;
  readonly signature: string | null;
  readonly outcome: "YES" | "NO" | null;
};

export type RedeemRow = {
  readonly label: string;
  readonly signature: string;
  readonly wallet: string;
};

export function latencySecs(row: Pick<SettlementRow, "closeTs" | "settledAt">): number | null {
  return row.settledAt === null ? null : row.settledAt - row.closeTs;
}

/** Within budget needs a settle transaction and `0 ≤ latency ≤ 600`. */
export function withinBudget(row: Pick<SettlementRow, "closeTs" | "settledAt">): boolean {
  const latency = latencySecs(row);
  return latency !== null && latency >= 0 && latency <= SETTLEMENT_BUDGET_SECS;
}

/** `7m05s` for 425 s; never negative. */
export function formatLatency(secs: number): string {
  const s = Math.max(0, secs);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function explorerTx(signature: string, cluster: "devnet" | "localnet"): string {
  return cluster === "devnet"
    ? `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    : signature;
}

export type Evidence = {
  readonly rows: readonly SettlementRow[];
  readonly redeems: readonly RedeemRow[];
  readonly cluster: "devnet" | "localnet";
};

/** `{ok, problems}`: every market settled, each within the budget; names what is missing. */
export function judge(evidence: Evidence): { readonly ok: boolean; readonly problems: string[] } {
  const problems: string[] = [];
  if (evidence.rows.length === 0) problems.push("no markets found for the date");
  for (const row of evidence.rows) {
    if (row.signature === null) problems.push(`${row.label}: not settled (no MarketSettled event)`);
    else if (!withinBudget(row)) {
      const latency = latencySecs(row);
      problems.push(
        `${row.label}: settled ${latency === null ? "at an unknown time" : `${formatLatency(latency)} after close`}, over the ${formatLatency(SETTLEMENT_BUDGET_SECS)} budget`,
      );
    }
  }
  if (evidence.redeems.length === 0) problems.push("no redeem transaction recorded");
  return { ok: problems.length === 0, problems };
}

/** Markdown for `docs/log.md`: one line per market and one per redeem, then the verdict. */
export function renderEvidence(
  evidence: Evidence,
  context: {
    readonly who: string;
    readonly date: string;
    readonly screenCapture: readonly string[];
  },
): string {
  const verdict = judge(evidence);
  const lines = [
    `### Recorded settlement · ${context.date} · ${verdict.ok ? "PASS" : "INCOMPLETE"}`,
  ];
  lines.push(`- Who: ${context.who}.`);
  for (const row of evidence.rows) {
    const latency = latencySecs(row);
    lines.push(
      `- ${row.label} (${row.market}): ${row.outcome ?? "not settled"}, ` +
        `${latency === null ? "latency n/a" : `settled ${formatLatency(latency)} after close`}` +
        `${row.signature === null ? "" : `, ${explorerTx(row.signature, evidence.cluster)}`}`,
    );
  }
  for (const redeem of evidence.redeems) {
    lines.push(
      `- Redeem ${redeem.label} by ${redeem.wallet}: ${explorerTx(redeem.signature, evidence.cluster)}`,
    );
  }
  lines.push(
    context.screenCapture.length === 0
      ? "- Screen captures: none recorded."
      : `- Screen captures: ${context.screenCapture.join(", ")}.`,
  );
  if (!verdict.ok) lines.push(`- Open items: ${verdict.problems.join("; ")}.`);
  return `${lines.join("\n")}\n`;
}
