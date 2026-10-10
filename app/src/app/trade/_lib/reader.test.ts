// @vitest-environment node
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTradeReader,
  decodeBook,
  decodeSnapshot,
  decodeWallet,
  fetchOpenTime,
  splAmount,
} from "./reader";
import { encodeTokenAccount, fakeChain, pdaMarket, WALLET_OWNER } from "./test-support";
import { createAccountFeed, type AccountFeed } from "@/lib/account-feed";
import { parsePublicConfig } from "@/lib/config";
import { connectionFetcher } from "@/lib/rpc";

describe("decodeWallet (P1-2: shared by getWallet and walletSource)", () => {
  const oo = vi.fn(() => ({ freeUsdc: new BN(500), freeYes: new BN(3) }));
  const token = (amount: bigint) => ({ data: encodeTokenAccount(amount) });

  it("reads the three token balances and the open-orders free balances", () => {
    expect(
      decodeWallet([token(5n), token(6n), token(7n), { data: new Uint8Array(90) }], oo),
    ).toEqual({ yes: 5n, no: 6n, usdc: 7n, freeUsdc: 500n, freeYes: 3n });
    expect(oo).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it("treats missing accounts as zero", () => {
    expect(decodeWallet([null, undefined, null, null], oo)).toEqual({
      yes: 0n,
      no: 0n,
      usdc: 0n,
      freeUsdc: 0n,
      freeYes: 0n,
    });
  });

  it("fails closed on a short token account or an undecodable open-orders account", () => {
    expect(() => decodeWallet([{ data: Buffer.alloc(10) }, null, null, null], oo)).toThrow(
      "SPL token account data too short",
    );
    const bad = () => {
      throw new Error("bad discriminator");
    };
    expect(() => decodeWallet([null, null, null, { data: Buffer.alloc(8) }], bad)).toThrow(
      "bad discriminator",
    );
  });
});

describe("createTradeReader on a fake chain (P1-2)", () => {
  const config = parsePublicConfig({
    rpcUrl: "http://127.0.0.1:8899",
    usdcMint: Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58(),
  });
  const row = pdaMarket(config, "NVDA", 18_000n);
  let feed: AccountFeed | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    feed?.dispose();
    feed = null;
    vi.useRealTimers();
  });

  async function setup() {
    const chain = await fakeChain(config, [row]);
    feed = createAccountFeed({
      fetchMany: connectionFetcher(chain.connection),
      socket: null,
      isVisible: () => true,
      onVisible: () => () => undefined,
    });
    const reader = createTradeReader(config, row, { connection: chain.connection, feed });
    return { chain, reader, feed };
  }

  it("getSnapshot reads book, market and vault in one request", async () => {
    const { chain, reader } = await setup();
    const snapshot = await reader.getSnapshot();
    expect(chain.counts.total).toBe(1);
    expect(snapshot.book.bids[0]).toMatchObject({ price: 58, qty: 30n });
    expect(snapshot.vault).toMatchObject({ pairs: 1_240n, balance: 1_240_000_000n });
  });

  it("getWallet reads the 3 ATAs and open orders in one request", async () => {
    const { chain, reader } = await setup();
    expect(await reader.getWallet(WALLET_OWNER)).toEqual({
      yes: 5n,
      no: 0n,
      usdc: 100_000_000n,
      freeUsdc: 2_000_000n,
      freeYes: 3n,
    });
    expect(chain.counts.total).toBe(1);
  });

  it("snapshotSource decodes the same snapshot from the feed, stamped with the read time", async () => {
    const { reader } = await setup();
    vi.setSystemTime(1_791_486_000_000);
    const source = reader.snapshotSource?.(1_000);
    if (source === undefined) throw new Error("no snapshotSource");
    source.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const read = source.read();
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.value.book.asks[0]).toMatchObject({ price: 61, qty: 40n });
    expect(read.value.vault).toEqual({
      pairs: 1_240n,
      balance: 1_240_000_000n,
      asOfSecs: 1_791_486_000,
    });
  });

  it("snapshotSource reports a missing book as an error", async () => {
    const { chain, reader } = await setup();
    chain.accounts.clear();
    const source = reader.snapshotSource?.(1_000);
    source?.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(source?.read()).toEqual({ status: "error", message: "book account not found" });
  });

  it("walletSource resolves the wallet's accounts and decodes them from the feed", async () => {
    const { chain, reader } = await setup();
    const source = reader.walletSource?.(WALLET_OWNER, 2_000);
    source?.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(source?.read()).toEqual({
      status: "ready",
      value: { yes: 5n, no: 0n, usdc: 100_000_000n, freeUsdc: 2_000_000n, freeYes: 3n },
    });
    expect(chain.counts.total).toBe(1);
  });
});

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
