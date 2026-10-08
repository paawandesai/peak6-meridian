import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertFunded,
  expectedCashChange,
  explorerUrl,
  type MarketRow,
  MIN_SECS_BEFORE_CLOSE,
  parseRehearsalArgs,
  parseState,
  pickMarket,
  serializeState,
  TRADER_MIN_LAMPORTS,
  TRADER_USDC_BASE_UNITS,
  wantsRehearsal,
} from "./rehearsal-plan";

const row = (over: Partial<MarketRow> = {}): MarketRow => ({
  address: "A",
  symbol: "META",
  strikeCents: 68_000n,
  closeTs: 10_000,
  open: true,
  pairsOutstanding: 0n,
  ...over,
});

describe("arguments", () => {
  it("only --cluster devnet selects the rehearsal path", () => {
    expect(wantsRehearsal(["--cluster", "devnet"])).toBe(true);
    expect(wantsRehearsal(["--cluster", "local"])).toBe(false);
    expect(wantsRehearsal([])).toBe(false);
  });

  it("parses a trade phase with defaults", () => {
    const args = parseRehearsalArgs(["--cluster", "devnet", "--phase", "trade"]);
    expect(args).toMatchObject({
      phase: "trade",
      symbol: "META",
      fund: "direct",
      localSettle: false,
    });
    expect(args.strikeCents).toBeUndefined();
  });

  it("parses every option", () => {
    const args = parseRehearsalArgs([
      "--cluster",
      "devnet",
      "--phase",
      "redeem",
      "--symbol",
      "AAPL",
      "--strike-cents",
      "23000",
      "--fund",
      "none",
      "--state-dir",
      "/tmp/x",
      "--local-settle",
    ]);
    expect(args).toMatchObject({
      symbol: "AAPL",
      strikeCents: 23000n,
      fund: "none",
      localSettle: true,
    });
  });

  it("rejects bad input", () => {
    const base = ["--cluster", "devnet"];
    expect(() => parseRehearsalArgs(["--phase", "trade"])).toThrow(/--cluster devnet/);
    expect(() => parseRehearsalArgs([...base])).toThrow(/--phase/);
    expect(() => parseRehearsalArgs([...base, "--phase", "nope"])).toThrow(/--phase/);
    expect(() => parseRehearsalArgs([...base, "--phase", "markets"])).toThrow(/--prev-closes/);
    expect(() => parseRehearsalArgs([...base, "--phase", "trade", "--symbol", "meta"])).toThrow();
    expect(() =>
      parseRehearsalArgs([...base, "--phase", "trade", "--strike-cents", "-1"]),
    ).toThrow();
    expect(() => parseRehearsalArgs([...base, "--phase", "trade", "--fund", "x"])).toThrow();
    expect(() => parseRehearsalArgs([...base, "--phase", "trade", "--bogus"])).toThrow();
  });
});

describe("state", () => {
  const state = {
    programId: "P",
    market: "M",
    symbol: "META",
    strikeCents: "68000",
    tradingDate: 20261008,
    closeTs: 1,
    traders: [
      { name: "trader-a", pubkey: "a" },
      { name: "trader-b", pubkey: "b" },
    ],
    startUsdc: { "trader-a": "1000000000", "trader-b": "1000000000" },
    holdings: {
      "trader-a": { cash: "-100", yes: "3", no: "0" },
      "trader-b": { cash: "100", yes: "-3", no: "0" },
    },
  };

  it("round-trips and rejects a malformed file", () => {
    expect(parseState(serializeState(state))).toEqual(state);
    expect(() => parseState(JSON.stringify({ ...state, traders: [] }))).toThrow();
    expect(() => parseState("{}")).toThrow();
  });

  it("a winner is paid 1 USDC per token, a loser nothing (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }),
        fc.bigInt({ min: 0n, max: 1000n }),
        fc.bigInt({ min: 0n, max: 1000n }),
        (cash, yes, no) => {
          const h = { cash: cash.toString(), yes: yes.toString(), no: no.toString() };
          expect(expectedCashChange(h, true)).toBe(cash + yes * 1_000_000n);
          expect(expectedCashChange(h, false)).toBe(cash + no * 1_000_000n);
        },
      ),
    );
  });
});

describe("pickMarket", () => {
  it("takes the lowest tradable strike of the symbol", () => {
    const rows = [row({ address: "hi", strikeCents: 70_000n }), row({ address: "lo" })];
    expect(pickMarket(rows, { symbol: "META", strikeCents: undefined }, 0).address).toBe("lo");
    expect(pickMarket(rows, { symbol: "META", strikeCents: 70_000n }, 0).address).toBe("hi");
  });

  it("skips settled, other-symbol and nearly closed markets, and explains why", () => {
    const rows = [
      row({ open: false }),
      row({ symbol: "AAPL" }),
      row({ closeTs: MIN_SECS_BEFORE_CLOSE - 1 }),
    ];
    expect(() => pickMarket(rows, { symbol: "META", strikeCents: undefined }, 0)).toThrow(
      /no open META market.*closes in 179s/s,
    );
    expect(() => pickMarket([], { symbol: "META", strikeCents: undefined }, 0)).toThrow(
      /morning job/,
    );
    expect(() => pickMarket([row()], { symbol: "META", strikeCents: 1n }, 0)).toThrow(/strike 1/);
  });
});

describe("funding and links", () => {
  it("assertFunded names what is missing", () => {
    expect(() =>
      assertFunded(
        "trader-a",
        { lamports: TRADER_MIN_LAMPORTS, usdc: TRADER_USDC_BASE_UNITS },
        "x",
      ),
    ).not.toThrow();
    expect(() => assertFunded("trader-a", { lamports: 0n, usdc: 0n }, "fund it")).toThrow(
      /trader-a is not funded.*lamports.*USDC.*fund it/,
    );
  });

  it("explorer links only for devnet", () => {
    expect(explorerUrl("devnet", "SIG")).toBe("https://explorer.solana.com/tx/SIG?cluster=devnet");
    expect(explorerUrl("localnet", "SIG")).toBe("SIG");
  });
});
