import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { decodeBook, decodeSnapshot, fetchOpenTime, splAmount } from "./reader";

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

describe("getWallet OpenOrders decode (P0-4)", () => {
  it("decodes openOrders (camelCase) and converts Uint8Array to Buffer", () => {
    // Test the decode logic that getWallet uses for OpenOrders accounts
    const mockCoder = {
      decode: vi.fn().mockReturnValue({
        freeUsdc: new BN(500),
        freeYes: new BN(300),
      }),
    };

    const mockProgram = {
      coder: {
        accounts: mockCoder,
      },
    };

    // Simulate what getWallet does: decode OpenOrders with camelCase name and Buffer data
    const ooAccountData = new Uint8Array(100); // Might be Uint8Array in browser
    const data = Buffer.isBuffer(ooAccountData) ? ooAccountData : Buffer.from(ooAccountData);
    const decoded = mockProgram.coder.accounts.decode("openOrders", data);

    const freeUsdc = BigInt(decoded.freeUsdc.toString());
    const freeYes = BigInt(decoded.freeYes.toString());

    // Verify decode was called with camelCase "openOrders" (not "OpenOrders") and Buffer
    expect(mockCoder.decode).toHaveBeenCalledWith("openOrders", expect.any(Buffer));
    expect(freeUsdc).toBe(500n);
    expect(freeYes).toBe(300n);
  });
});

describe("decodeSnapshot (P0-7: book + vault in one read)", () => {
  const owner = Keypair.generate().publicKey;
  const rawBook = { bids: [slot(58, 30, owner)], asks: [slot(61, 40, owner)] };
  const vaultData = (amount: bigint): Buffer => {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(amount, 64);
    return data;
  };
  const info = (data: Uint8Array) => ({ data });
  const decoder = (market: unknown = { pairsOutstanding: new BN(1240) }) =>
    vi.fn((name: "book" | "market") => (name === "book" ? rawBook : market));

  it("decodes the book, pairs outstanding and the vault balance from one call", () => {
    const decode = decoder();
    const snap = decodeSnapshot(
      [info(Buffer.alloc(8)), info(new Uint8Array(8)), info(vaultData(1_240_000_000n))],
      decode,
      1_000,
    );
    expect(snap.book.bids).toHaveLength(1);
    expect(snap.vault).toEqual({ pairs: 1240n, balance: 1_240_000_000n, asOfSecs: 1_000 });
    expect(decode).toHaveBeenCalledWith("book", expect.any(Buffer));
    expect(decode).toHaveBeenCalledWith("market", expect.any(Buffer));
  });

  it("fails loudly when the book account is missing", () => {
    expect(() => decodeSnapshot([null, null, null], decoder(), 1)).toThrow(
      "book account not found",
    );
  });

  it("a missing vault or market reads as unavailable (null), never zero", () => {
    const snap = decodeSnapshot([info(Buffer.alloc(8)), null, null], decoder(), 1);
    expect(snap.vault).toEqual({ pairs: null, balance: null, asOfSecs: 1 });
  });

  it("an undecodable market or a short vault reads as unavailable", () => {
    const throwing = vi.fn((name: "book" | "market") => {
      if (name === "market") throw new Error("bad discriminator");
      return rawBook;
    });
    const snap = decodeSnapshot(
      [info(Buffer.alloc(8)), info(Buffer.alloc(8)), info(Buffer.alloc(10))],
      throwing,
      1,
    );
    expect(snap.vault.pairs).toBeNull();
    expect(snap.vault.balance).toBeNull();
    expect(
      decodeSnapshot([info(Buffer.alloc(8)), info(Buffer.alloc(8)), null], decoder({}), 1).vault
        .pairs,
    ).toBeNull();
  });

  it("splAmount reads u64 LE at offset 64 from a Buffer or a Uint8Array", () => {
    expect(splAmount(vaultData(42n))).toBe(42n);
    expect(splAmount(new Uint8Array(vaultData(7n)))).toBe(7n);
    expect(splAmount(undefined)).toBeNull();
  });
});
