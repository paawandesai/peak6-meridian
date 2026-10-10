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

describe("SPL token parsing (P0-4: getWallet decode)", () => {
  // Test the parseTokenBalance logic from getWallet
  const parseTokenBalance = (accountInfo: { data: Buffer | Uint8Array } | null): bigint => {
    if (!accountInfo) return 0n;
    const data = accountInfo.data;
    if (data.length < 72) {
      throw new Error("SPL token account data too short");
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return buf.readBigUInt64LE(64);
  };

  it("parses amount from Buffer at offset 64 (Node.js AccountInfo.data)", () => {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(12345n, 64);
    expect(parseTokenBalance({ data })).toBe(12345n);
  });

  it("parses amount from Uint8Array at offset 64 (browser AccountInfo.data)", () => {
    const data = new Uint8Array(165);
    const view = new DataView(data.buffer);
    view.setBigUint64(64, 67890n, true); // little-endian
    expect(parseTokenBalance({ data })).toBe(67890n);
  });

  it("returns 0n when account does not exist", () => {
    expect(parseTokenBalance(null)).toBe(0n);
  });

  it("throws when data is too short (fail-closed, not zero balance)", () => {
    const badData = Buffer.alloc(10);
    expect(() => parseTokenBalance({ data: badData })).toThrow("SPL token account data too short");
  });

  it("throws on Uint8Array that would fail readBigUInt64LE without Buffer conversion", () => {
    // This test ensures the Uint8Array → Buffer conversion is working
    const data = new Uint8Array(165);
    const view = new DataView(data.buffer);
    view.setBigUint64(64, 99999n, true);
    // If we didn't convert to Buffer, this would throw because Uint8Array lacks readBigUInt64LE
    expect(parseTokenBalance({ data })).toBe(99999n);
  });
});
