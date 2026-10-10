// @vitest-environment node
/**
 * P1-5 AC "matches the MM's on-chain orders": OpenOrders and Book accounts are serialized from the
 * IDL (the bytes the program writes), served by a fake RPC, read through the Portfolio's real
 * `createPortfolioSource` (Anchor decode + `restingOrders`) and turned into the MM block. Every
 * figure the block shows is checked against the orders encoded here. No network is touched.
 */
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { BN, marketAddresses, MERIDIAN_IDL } from "@meridian/client";
import { type AccountInfo, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  calls: [] as { method: string; count: number }[],
  programAccounts: [] as { pubkey: unknown; account: unknown }[],
  accounts: new Map<string, Buffer>(),
}));

vi.mock("@/lib/rpc", () => ({
  sharedConnection: () => ({
    commitment: "confirmed",
    rpcEndpoint: "http://fake.invalid",
    getParsedTokenAccountsByOwner: () => {
      rpc.calls.push({ method: "getParsedTokenAccountsByOwner", count: 1 });
      return Promise.resolve({ context: { slot: 1 }, value: [] });
    },
    getProgramAccounts: () => {
      rpc.calls.push({ method: "getProgramAccounts", count: 1 });
      return Promise.resolve(rpc.programAccounts);
    },
    getMultipleAccountsInfoAndContext: (keys: PublicKey[]) => {
      rpc.calls.push({ method: "getMultipleAccountsInfoAndContext", count: keys.length });
      return Promise.resolve({ context: { slot: 1 }, value: keys.map(accountAt) });
    },
    getMultipleAccountsInfo: (keys: PublicKey[]) => {
      rpc.calls.push({ method: "getMultipleAccountsInfo", count: keys.length });
      return Promise.resolve(keys.map(accountAt));
    },
    getAccountInfo: () => {
      rpc.calls.push({ method: "getAccountInfo", count: 1 });
      return Promise.resolve(null);
    },
    getSignaturesForAddress: () => {
      rpc.calls.push({ method: "getSignaturesForAddress", count: 1 });
      return Promise.resolve([]);
    },
    getTransactions: () => Promise.resolve([]),
  }),
}));

import { createPortfolioSource } from "./data";
import { AAPL, NVDA } from "./fixtures";
import { buildPortfolio } from "./model";
import { parsePublicConfig } from "@/lib/config";
import { market } from "@/test-utils";

const config = parsePublicConfig({ rpcUrl: "http://fake.invalid" });
const coder = new BorshAccountsCoder(MERIDIAN_IDL);
const wallet = PublicKey.unique();
const other = PublicKey.unique();
const CENT = 10_000n;

function accountAt(key: PublicKey): AccountInfo<Buffer> | null {
  const data = rpc.accounts.get(key.toBase58());
  return data === undefined
    ? null
    : { data, executable: false, lamports: 1, owner: config.programId, rentEpoch: 0 };
}

type Order = { id: number; owner: PublicKey; price: number; qty: number };
const EMPTY: Order = { id: 0, owner: PublicKey.default, price: 0, qty: 0 };

/** `BookOrder` (repr C, bytemuck): order_id u64, owner, price u8, 7 pad, qty u64, seq u64. */
const ORDER_BYTES = 64;
const BOOK_SIDE = 32;

function writeSide(buffer: Buffer, offset: number, orders: readonly Order[]): number {
  const filled = [...orders, ...Array<Order>(BOOK_SIDE - orders.length).fill(EMPTY)];
  filled.forEach((order, index) => {
    const at = offset + index * ORDER_BYTES;
    buffer.writeBigUInt64LE(BigInt(order.id), at);
    order.owner.toBuffer().copy(buffer, at + 8);
    buffer.writeUInt8(order.price, at + 40);
    buffer.writeBigUInt64LE(BigInt(order.qty), at + 48);
    buffer.writeBigUInt64LE(BigInt(index), at + 56);
  });
  return offset + BOOK_SIDE * ORDER_BYTES;
}

/**
 * The `Book` zero-copy account bytes, laid out field by field from the IDL (Anchor's TS encoder
 * caps its scratch buffer at 1000 bytes, smaller than a book). Decoding still goes through
 * Anchor's own IDL decoder in `createPortfolioSource`, so a layout mistake here fails the test.
 */
function putBook(row: typeof NVDA, bids: Order[], asks: Order[]) {
  const book = marketAddresses(marketKey(row), config.programId).book;
  const discriminator = MERIDIAN_IDL.accounts?.find((item) => item.name === "Book")?.discriminator;
  if (discriminator === undefined) throw new Error("Book is missing from the IDL");
  const data = Buffer.alloc(8 + 2 * BOOK_SIDE * ORDER_BYTES + 8 + 32 + 1 + 7);
  Buffer.from(discriminator).copy(data, 0);
  let offset = writeSide(data, 8, bids);
  offset = writeSide(data, offset, asks);
  data.writeBigUInt64LE(99n, offset);
  new PublicKey(row.address).toBuffer().copy(data, offset + 8);
  data.writeUInt8(255, offset + 40);
  rpc.accounts.set(book.toBase58(), data);
}

async function putOpenOrders(
  row: typeof NVDA,
  fields: { freeUsdc: bigint; freeYes: bigint; restingCount: number },
) {
  const data = await coder.encode("OpenOrders", {
    owner: wallet,
    market: new PublicKey(row.address),
    free_usdc: new BN(fields.freeUsdc.toString()),
    free_yes: new BN(fields.freeYes.toString()),
    resting_count: fields.restingCount,
    bump: 254,
  });
  rpc.programAccounts.push({
    pubkey: PublicKey.unique(),
    account: { data, executable: false, lamports: 1, owner: config.programId, rentEpoch: 0 },
  });
}

function marketKey(row: typeof NVDA) {
  return { symbol: row.ticker, tradingDate: row.tradingDate, strikeCents: row.strikeCents };
}

beforeEach(() => {
  rpc.calls.length = 0;
  rpc.programAccounts.length = 0;
  rpc.accounts.clear();
});

const NVDA_190 = market({
  address: PublicKey.unique().toBase58(),
  ticker: "NVDA",
  tradingDate: 20261008,
  strikeCents: 19_000n,
  closeTs: NVDA.closeTs,
});

describe("MM block from serialized on-chain accounts", () => {
  it("matches every resting order, escrow and free balance the accounts hold", async () => {
    // NVDA $180: two bids and one ask of ours, one bid of another wallet, empty slots between.
    putBook(
      NVDA,
      [
        { id: 1, owner: wallet, price: 58, qty: 10 },
        { id: 2, owner: other, price: 59, qty: 50 },
        { id: 3, owner: wallet, price: 57, qty: 20 },
      ],
      [{ id: 4, owner: wallet, price: 61, qty: 10 }],
    );
    await putOpenOrders(NVDA, { freeUsdc: 1_500_000n, freeYes: 5n, restingCount: 3 });
    // NVDA $190: one ask of ours, nothing free.
    putBook(NVDA_190, [], [{ id: 7, owner: wallet, price: 33, qty: 15 }]);
    await putOpenOrders(NVDA_190, { freeUsdc: 0n, freeYes: 0n, restingCount: 1 });
    // AAPL: no resting orders, only an unsettled balance (its book must not be read).
    await putOpenOrders(AAPL, { freeUsdc: 400_000n, freeYes: 0n, restingCount: 0 });

    const markets = [NVDA, NVDA_190, AAPL];
    const snap = await createPortfolioSource(config).load(wallet, markets);

    // One batched multi-account read for both books, never a per-market call.
    const multi = rpc.calls.filter((call) => call.method.startsWith("getMultipleAccounts"));
    expect(multi).toEqual([{ method: expect.stringMatching(/^getMultipleAccounts/), count: 2 }]);
    expect(rpc.calls.some((call) => call.method === "getAccountInfo")).toBe(false);

    const model = buildPortfolio({
      wallet: wallet.toBase58(),
      markets,
      snapshot: snap,
      quotes: {},
      usdcBalance: null,
    });
    const [aapl, nvda180, nvda190] = model.mm.strikes;
    expect(model.mm.strikes.map((strike) => strike.market)).toEqual([AAPL, NVDA, NVDA_190]);

    // YES held = free 5 + 10 resting in the ask; no wallet tokens.
    expect(nvda180).toMatchObject({
      net: 15n,
      resting: 3,
      bids: { count: 2, qty: 30n, best: 58 },
      asks: { count: 1, qty: 10n, best: 61 },
      netIfBidsFill: 45n,
      netIfAsksFill: 5n,
      escrowUsdc: (58n * 10n + 57n * 20n) * CENT,
      escrowYes: 10n,
      freeUsdc: 1_500_000n,
      freeYes: 5n,
      mismatch: false,
    });
    expect(nvda190).toMatchObject({
      net: 15n,
      resting: 1,
      bids: { count: 0, qty: 0n, best: null },
      asks: { count: 1, qty: 15n, best: 33 },
      netIfAsksFill: 0n,
      escrowUsdc: 0n,
      mismatch: false,
    });
    expect(aapl).toMatchObject({ resting: 0, freeUsdc: 400_000n, mismatch: false });
    expect(model.mm).toMatchObject({
      openOrders: 4,
      bidQty: 30n,
      askQty: 25n,
      escrowUsdc: 1_720_000n * 10n,
      unsettledUsdc: 1_900_000n,
      unsettledYes: 5n,
      withdrawable: [NVDA, AAPL],
    });
  });

  it("a book account missing from the RPC shows the strike as a count mismatch, not zero orders", async () => {
    await putOpenOrders(NVDA, { freeUsdc: 0n, freeYes: 0n, restingCount: 2 });
    const snap = await createPortfolioSource(config).load(wallet, [NVDA]);
    const model = buildPortfolio({
      wallet: wallet.toBase58(),
      markets: [NVDA],
      snapshot: snap,
      quotes: {},
      usdcBalance: null,
    });
    expect(model.mm.strikes[0]).toMatchObject({ resting: 2, mismatch: true });
    expect(model.mm.strikes[0]?.bids.count).toBe(0);
  });
});
