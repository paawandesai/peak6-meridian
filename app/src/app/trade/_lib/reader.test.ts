import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { decodeBook, fetchOpenTime } from "./reader";

const slot = (price: number, qty: number, owner: PublicKey) => ({
  orderId: { toString: () => String(price) },
  owner,
  price,
  qty: { toString: () => String(qty) },
  seq: { toString: () => "1" },
});

describe("decodeBook", () => {
  it("decodes orders to bigint quantities and base58 owners, dropping empty slots", () => {
    const owner = Keypair.generate().publicKey;
    const book = decodeBook({
      bids: [slot(58, 30, owner), slot(0, 0, owner)],
      asks: [slot(61, 40, owner)],
    });
    expect(book.bids).toEqual([
      { orderId: 58n, owner: owner.toBase58(), price: 58, qty: 30n, seq: 1n },
    ]);
    expect(book.asks).toHaveLength(1);
  });
});

describe("fetchOpenTime (D-050)", () => {
  const market = Keypair.generate().publicKey;
  const entry = (signature: string, blockTime: number | null) => ({
    signature,
    slot: 1,
    err: null,
    memo: null,
    blockTime,
  });

  it("is the block time of the oldest signature", async () => {
    const connection = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([entry("new", 200), entry("old", 100)]),
    };
    expect(await fetchOpenTime(connection, market)).toBe(100);
  });

  it("pages back while pages are full", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => entry(`s${i}`, 500 - i / 10));
    const connection = {
      getSignaturesForAddress: vi
        .fn()
        .mockResolvedValueOnce(full)
        .mockResolvedValueOnce([entry("first", 42)]),
    };
    expect(await fetchOpenTime(connection, market)).toBe(42);
    expect(connection.getSignaturesForAddress).toHaveBeenLastCalledWith(
      market,
      { limit: 1000, before: "s999" },
      "confirmed",
    );
  });

  it("is null when there is no history, no block time, or too much history", async () => {
    expect(
      await fetchOpenTime({ getSignaturesForAddress: vi.fn().mockResolvedValue([]) }, market),
    ).toBeNull();
    expect(
      await fetchOpenTime(
        { getSignaturesForAddress: vi.fn().mockResolvedValue([entry("a", null)]) },
        market,
      ),
    ).toBeNull();
    const full = Array.from({ length: 1000 }, (_, i) => entry(`s${i}`, 1));
    const endless = { getSignaturesForAddress: vi.fn().mockResolvedValue(full) };
    expect(await fetchOpenTime(endless, market)).toBeNull();
    expect(endless.getSignaturesForAddress).toHaveBeenCalledTimes(5);
  });
});
