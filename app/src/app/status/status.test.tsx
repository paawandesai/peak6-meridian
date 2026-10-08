import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EMPTY_TEXT, StatusView } from "./status-view";
import { decodeEvents } from "@/lib/events";
import fixture from "@/lib/fixtures/events.json";
import {
  BOOK_COVERAGE_TEXT,
  buildDays,
  etWallClockToUnix,
  factsFromEvents,
  formatEtStamp,
  invariantRow,
  marketStatusRow,
  NO_FACTS,
  oracleAgeSlots,
  slotsToSecs,
} from "@/lib/status";
import { market } from "@/test-utils";

const DATE = 20261008;
const OPEN = etWallClockToUnix(DATE, 9, 0);
const CLOSE = etWallClockToUnix(DATE, 16, 0);
const good = market({
  address: "Good",
  ticker: "NVDA",
  strikeCents: 18_000n,
  tradingDate: DATE,
  closeTs: BigInt(CLOSE),
  settled: true,
  outcome: "Yes",
  pairsOutstanding: 5n,
});
const bad = market({
  address: "Bad",
  ticker: "AAPL",
  strikeCents: 23_000n,
  tradingDate: DATE,
  closeTs: BigInt(CLOSE),
  pairsOutstanding: 3n,
});
const facts = (over: Partial<typeof NO_FACTS> = {}) => ({ ...NO_FACTS, ...over });

describe("invariant (Pass and Fail fixtures)", () => {
  it("passes only on an exact vault match", () => {
    expect(invariantRow(good, 5_000_000n).verdict).toBe("Pass");
    expect(invariantRow(good, 4_999_999n).verdict).toBe("Fail");
    expect(invariantRow(good, 5_000_001n).verdict).toBe("Fail");
    expect(invariantRow(good, null).verdict).toBe("Fail");
    expect(invariantRow(market({ pairsOutstanding: 0n }), 0n).verdict).toBe("Pass");
  });
});

describe("time helpers", () => {
  it("09:00 ET is DST-aware", () => {
    expect(formatEtStamp(etWallClockToUnix(20261008, 9, 0))).toBe("2026-10-08 09:00:00 ET");
    expect(formatEtStamp(etWallClockToUnix(20261207, 9, 0))).toBe("2026-12-07 09:00:00 ET");
    expect(etWallClockToUnix(20261207, 9, 0) - etWallClockToUnix(20261008, 9, 0)).not.toBe(
      60 * 24 * 3600,
    );
    expect(() => etWallClockToUnix(20260308, 2, 30)).toThrow(RangeError);
  });
  it("oracle age is in whole slots, never negative", () => {
    expect(oracleAgeSlots(facts({ settleSlot: 1_000, oracleSlot: 970n }))).toBe(30n);
    expect(oracleAgeSlots(facts({ settleSlot: 1_000, oracleSlot: 1_005n }))).toBe(0n);
    expect(oracleAgeSlots(facts({ settleSlot: 1_000 }))).toBeNull();
    expect(slotsToSecs(30n)).toBe(12n);
  });
  it("facts come from decoded M2-05 events", () => {
    const events = decodeEvents(
      fixture.logs,
      { signature: fixture.signature, blockTime: fixture.blockTime },
      fixture.programId,
    );
    expect(factsFromEvents(events, 777)).toEqual({
      createdAt: fixture.blockTime,
      settledAt: fixture.blockTime,
      settleSlot: 777,
      oracleSlot: 321n,
    });
    expect(factsFromEvents([], 5)).toEqual(NO_FACTS);
  });
});

describe("per-day liveness", () => {
  it("settle state: pending, on time, late, unknown", () => {
    const at = (secs: number) => facts({ settledAt: CLOSE + secs });
    expect(marketStatusRow(bad, 0n, NO_FACTS).settlement).toBe("Pending");
    expect(marketStatusRow(good, 0n, at(300)).settlement).toBe("On time");
    expect(marketStatusRow(good, 0n, at(1200)).settlement).toBe("On time");
    expect(marketStatusRow(good, 0n, at(1201)).settlement).toBe("Late");
    expect(marketStatusRow(good, 0n, NO_FACTS).settlement).toBe("Unknown");
  });
  it("creation passes only when every market was created by 09:00 ET", () => {
    const rows = (a: number | null, b: number | null) => [
      marketStatusRow(good, 0n, facts({ createdAt: a })),
      marketStatusRow(bad, 0n, facts({ createdAt: b })),
    ];
    expect(buildDays(rows(OPEN - 60, OPEN)).at(0)?.creation).toBe("Pass");
    expect(buildDays(rows(OPEN - 60, OPEN + 1)).at(0)?.creation).toBe("Fail");
    expect(buildDays(rows(OPEN - 60, null)).at(0)?.creation).toBe("Fail");
  });
  it("groups days newest first with sorted rows", () => {
    const older = market({ address: "Old", tradingDate: 20261007 });
    const days = buildDays([older, good, bad].map((m) => marketStatusRow(m, null, NO_FACTS)));
    expect(days.map((d) => d.tradingDate)).toEqual([DATE, 20261007]);
    expect(days[0]?.rows.map((r) => r.market.ticker)).toEqual(["AAPL", "NVDA"]);
  });
});

describe("StatusView (UI-07 AC1/AC2)", () => {
  const data = {
    markets: [good, bad],
    vaults: new Map<string, bigint | null>([
      ["Good", 5_000_000n],
      ["Bad", 2_000_000n],
    ]),
    facts: new Map([
      [
        "Good",
        facts({
          createdAt: OPEN - 600,
          settledAt: CLOSE + 330,
          settleSlot: 1_000,
          oracleSlot: 970n,
        }),
      ],
      ["Bad", facts({ createdAt: OPEN - 300 })],
    ]),
  };

  it("renders Pass and Fail as text, with every US-19 metric", () => {
    render(<StatusView data={data} />);
    const invariant = screen.getByRole("table", { name: /vault balance/i });
    const rows = within(invariant).getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByText("Fail")).toBeInTheDocument(); // AAPL first
    expect(within(rows[2] as HTMLElement).getByText("Pass")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getAllByText("5.00 test-USDC")).toHaveLength(2);
    expect(screen.getByText("Markets created vs 09:00 ET")).toBeInTheDocument();
    expect(screen.getByText("Settled vs close")).toBeInTheDocument();
    expect(screen.getByText("Oracle age at settle")).toBeInTheDocument();
    expect(screen.getAllByText(/5 min 30 s after close/).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/30 slots \(about 12 s\)/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Settled YES · On time/)).toBeInTheDocument();
    expect(screen.getByText(/Not settled · Pending/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(BOOK_COVERAGE_TEXT))).toBeInTheDocument();
  });

  it("shows unavailable data as text, never a blank or zero", () => {
    render(<StatusView data={{ markets: [good], vaults: new Map(), facts: new Map() }} />);
    expect(screen.getAllByText("unavailable").length).toBeGreaterThan(2);
    expect(screen.getAllByText("Fail").length).toBeGreaterThan(0);
  });

  it("has an empty state", () => {
    render(<StatusView data={{ markets: [], vaults: new Map(), facts: new Map() }} />);
    expect(screen.getByText(EMPTY_TEXT)).toBeInTheDocument();
  });
});
