import type { Program } from "@coral-xyz/anchor";
import type { Meridian } from "@meridian/client";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  connectReadOnly,
  etTradingDate,
  isoDate,
  marketsOfDate,
  strikeLabel,
} from "./friday-chain";

describe("ET trading date", () => {
  it("is the New York calendar date, not the UTC one", () => {
    // 2026-10-09 23:30 EDT is 2026-10-10 03:30 UTC.
    expect(etTradingDate(Date.UTC(2026, 9, 10, 3, 30) / 1000)).toBe(20261009);
    // 2026-10-09 00:30 EDT is 04:30 UTC the same day.
    expect(etTradingDate(Date.UTC(2026, 9, 9, 4, 30) / 1000)).toBe(20261009);
  });

  it("follows the DST change (2026-11-01 01:30 EST is 06:30 UTC)", () => {
    expect(etTradingDate(Date.UTC(2026, 10, 1, 6, 30) / 1000)).toBe(20261101);
    expect(etTradingDate(Date.UTC(2026, 10, 2, 4, 59) / 1000)).toBe(20261101);
    expect(etTradingDate(Date.UTC(2026, 10, 2, 5, 0) / 1000)).toBe(20261102);
  });

  it("formats YYYYMMDD as an ISO date", () => {
    expect(isoDate(20261009)).toBe("2026-10-09");
  });
});

describe("market helpers", () => {
  it("labels a strike in whole dollars", () => {
    expect(strikeLabel("META", 68_000n)).toBe("META $680");
  });

  it("lists only the given date's markets with their state", async () => {
    const symbol = (text: string) => Array.from(Buffer.from(text.padEnd(8, "\0")));
    const account = (ticker: string, date: number, settled: boolean) => ({
      publicKey: Keypair.generate().publicKey,
      account: {
        ticker: symbol(ticker),
        tradingDate: date,
        strikeCents: { toString: () => "68000" },
        closeTs: { toString: () => "1791000000" },
        status: settled ? { settled: {} } : { open: {} },
      },
    });
    const rows = [
      account("META", 20261009, false),
      account("AAPL", 20261008, false),
      account("NVDA", 20261009, true),
    ];
    const program = {
      account: { market: { all: () => Promise.resolve(rows) } },
    } as unknown as Program<Meridian>;
    const day = await marketsOfDate(program, 20261009);
    expect(day.map((m) => [m.label, m.closeTs, m.settled])).toEqual([
      ["META $680", 1_791_000_000, false],
      ["NVDA $680", 1_791_000_000, true],
    ]);
  });
});

describe("connectReadOnly", () => {
  it("never echoes the RPC URL (which may carry an API key) in an error", async () => {
    for (const url of ["http://127.0.0.1:9/?api-key=SECRET123", "SECRET123 not a url"]) {
      let message = "";
      try {
        await connectReadOnly({ SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: url });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("SECRET123");
    }
  });

  it("refuses an unknown cluster before connecting", async () => {
    await expect(
      connectReadOnly({ SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: "http://127.0.0.1:9" }),
    ).rejects.toThrow();
  });
});
