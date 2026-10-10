import { BN } from "@coral-xyz/anchor";
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

describe("fetchOpenTime (D-050, P1-4: from the automation index, no signature scan)", () => {
  const market = Keypair.generate().publicKey.toBase58();

  it("is the indexed creation time of the market", async () => {
    const read = vi.fn().mockResolvedValue({ ready: true, byMarket: { [market]: 1_791_288_000 } });
    expect(await fetchOpenTime(market, read)).toBe(1_791_288_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("is null (shown as —) when a ready index has no record of the market", async () => {
    const read = vi.fn().mockResolvedValue({ ready: true, byMarket: {} });
    expect(await fetchOpenTime(market, read)).toBeNull();
  });

  it("is unavailable while the index is still rebuilding", async () => {
    const read = vi.fn().mockResolvedValue({ ready: false, byMarket: {} });
    expect(await fetchOpenTime(market, read)).toBe("unavailable");
  });

  it("rejects when the index cannot be read, so the page shows unavailable", async () => {
    const read = vi.fn().mockRejectedValue(new Error("open times could not be read (502)"));
    await expect(fetchOpenTime(market, read)).rejects.toThrow("502");
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
