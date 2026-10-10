import { describe, expect, it } from "vitest";

import { type DemoMarketsReport } from "./markets";
import { formatMarketsReport, formatSettleReport, table } from "./report";
import { type DemoSettleReport } from "./settle";

const CLOSE_TS = Date.UTC(2026, 9, 12, 0, 0) / 1000;

const MARKETS: DemoMarketsReport = {
  tradingDate: "2026-10-11",
  asOf: "2026-10-09",
  prevDate: "2026-10-08",
  closeTs: CLOSE_TS,
  rows: [
    { ticker: "AAPL", strikeCents: 33_000n, status: "created", signature: "sig1" },
    { ticker: "AAPL", strikeCents: 34_000n, status: "exists" },
  ],
  session: {
    tradingDate: "2026-10-11",
    asOf: "2026-10-09",
    closeTs: CLOSE_TS,
    createdAt: "2026-10-10T16:00:00.000Z",
    tickers: ["AAPL", "MSFT"],
    strikesByTicker: { AAPL: [33_000, 34_000] },
    asOfCloseCentsByTicker: { AAPL: 33_606 },
    prevCloseCentsByTicker: { AAPL: 34_058 },
  },
  registry: { sessions: [] },
  foreignMarkets: 0,
};

describe("table", () => {
  it("pads columns to the widest cell", () => {
    expect(table(["a", "bb"], [["ccc", "d"]])).toBe("a    bb\n---  --\nccc  d");
  });
});

describe("formatMarketsReport", () => {
  it("states the demo nature, the simulated session, the ET close and every market", () => {
    const text = formatMarketsReport(MARKETS, false);
    expect(text).toContain("DEMO session 2026-10-11 (non-trading day)");
    expect(text).toContain("simulates the 2026-10-09 session · strikes from the 2026-10-08 closes");
    expect(text).toContain("trading closes Sun Oct 11 2026 8:00 PM ET");
    expect(text).toMatch(/AAPL\s+\$340\.58\s+\$336\.06\s+\$330\.00 \$340\.00/);
    expect(text).toMatch(/MSFT\s+\$0\.00\s+unknown/);
    expect(text).toMatch(/AAPL\s+\$330\.00\s+created\s+sig1/);
    expect(text).toContain("markets: 1 created, 1 exists");
    expect(text).not.toContain("WARNING");
    expect(formatMarketsReport(MARKETS, true).startsWith("DRY RUN · ")).toBe(true);
    expect(formatMarketsReport({ ...MARKETS, foreignMarkets: 2 }, false)).toContain(
      "WARNING: 2 other market(s) already on 2026-10-11",
    );
  });
});

describe("formatSettleReport", () => {
  const market = { address: "m", ticker: "AAPL", strikeCents: 33_000n, closeTs: CLOSE_TS };
  const base: DemoSettleReport = {
    tradingDate: "2026-10-11",
    asOf: "2026-10-09",
    rows: [],
    registry: { sessions: [] },
    ok: true,
  };

  it("says when nothing is open", () => {
    expect(formatSettleReport(base, false)).toContain("no open markets on 2026-10-11");
  });

  it("lists price, outcome and status, and the too-early time", () => {
    const text = formatSettleReport(
      {
        ...base,
        ok: false,
        rows: [
          {
            market,
            status: "too early",
            priceCents: 33_606,
            outcome: "YES",
            allowedFromTs: CLOSE_TS + 3600,
            detail: "too early, allowed from Sun Oct 11 2026 9:00 PM ET",
          },
          { market, status: "no price", allowedFromTs: CLOSE_TS, detail: "no close" },
        ],
      },
      true,
    );
    expect(text.startsWith("DRY RUN · DEMO settle 2026-10-11 at the 2026-10-09 closes")).toBe(true);
    expect(text).toMatch(/AAPL\s+\$330\.00\s+\$336\.06\s+YES\s+too early/);
    expect(text).toMatch(/AAPL\s+\$330\.00\s+-\s+-\s+no price/);
    expect(text).toContain("the override is allowed from Sun Oct 11 2026 9:00 PM ET; re-run then");
  });
});
