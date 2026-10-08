// @vitest-environment node
import { marketAddresses } from "@meridian/client";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  type EventConnection,
  orderSignatures,
  fetchBalancesByMint,
  fetchWalletEvents,
  holdingsFor,
  restingOrders,
  SIGNATURE_LIMIT,
} from "./data";
import { AAPL, NVDA } from "./fixtures";
import fixture from "@/lib/fixtures/events.json";

const programId = new PublicKey(fixture.programId);
const wallet = Keypair.generate().publicKey;

function connection(
  signatures: Record<string, { signature: string; slot: number; err: unknown }[]>,
  logs: Record<string, readonly string[] | null>,
) {
  const getSignaturesForAddress = vi.fn((address: PublicKey) =>
    Promise.resolve(signatures[address.toBase58()] ?? []),
  );
  const getTransactions = vi.fn((sigs: string[]) =>
    Promise.resolve(
      sigs.map((signature) => {
        const value = logs[signature];
        return value === null || value === undefined
          ? null
          : { blockTime: fixture.blockTime, meta: { logMessages: [...value] } };
      }),
    ),
  );
  return {
    connection: { getSignaturesForAddress, getTransactions } as unknown as EventConnection,
    getSignaturesForAddress,
    getTransactions,
  };
}

describe("fetchWalletEvents", () => {
  it("reads the wallet and its OpenOrders, dedupes signatures, skips failures, orders oldest first", async () => {
    const oo = Keypair.generate().publicKey;
    const { connection: c, getTransactions } = connection(
      {
        [wallet.toBase58()]: [
          { signature: "newer", slot: 20, err: null },
          { signature: "failed", slot: 15, err: { InstructionError: [0, "x"] } },
        ],
        [oo.toBase58()]: [
          { signature: "newer", slot: 20, err: null },
          { signature: "older", slot: 10, err: null },
        ],
      },
      { older: fixture.logs, newer: fixture.logs },
    );
    const { events, partial } = await fetchWalletEvents(c, [wallet, oo], programId);
    expect(partial).toBe(false);
    expect(events.length).toBeGreaterThan(0);
    const order = [...new Set(events.map((event) => event.signature))];
    expect(order).toEqual(["older", "newer"]);
    expect(getTransactions).toHaveBeenCalledTimes(1);
    expect(getTransactions.mock.calls[0]?.[0]).toEqual(["older", "newer"]);
    expect(events.every((event) => event.blockTime === fixture.blockTime)).toBe(true);
  });

  it("marks the history partial when an address returns a full page", async () => {
    const page = Array.from({ length: SIGNATURE_LIMIT }, (_, index) => ({
      signature: `s${index}`,
      slot: index,
      err: null,
    }));
    const { connection: c } = connection({ [wallet.toBase58()]: page }, {});
    const { events, partial } = await fetchWalletEvents(c, [wallet], programId);
    expect(partial).toBe(true);
    expect(events).toEqual([]);
  });

  it("tolerates a transaction the RPC no longer has and logs without events", async () => {
    const { connection: c } = connection(
      {
        [wallet.toBase58()]: [
          { signature: "gone", slot: 1, err: null },
          { signature: "empty", slot: 2, err: null },
        ],
      },
      { gone: null, empty: ["Program log: hi"] },
    );
    expect((await fetchWalletEvents(c, [wallet], programId)).events).toEqual([]);
  });
});

describe("balances and holdings", () => {
  it("sums token accounts by mint and maps them to each market's YES and NO", async () => {
    const a = marketAddresses(
      { symbol: NVDA.ticker, tradingDate: NVDA.tradingDate, strikeCents: NVDA.strikeCents },
      programId,
    );
    const accounts = [
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    ];
    let next = 0;
    const entry = (mint: PublicKey, amount: string) => ({
      pubkey: accounts[next++ % accounts.length],
      account: { data: { parsed: { info: { mint: mint.toBase58(), tokenAmount: { amount } } } } },
    });
    const balances = await fetchBalancesByMint(
      {
        getParsedTokenAccountsByOwner: () =>
          Promise.resolve({
            context: { slot: 1 },
            value: [entry(a.yesMint, "4"), entry(a.yesMint, "6"), entry(a.noMint, "2")],
          }),
      } as never,
      wallet,
    );
    // Totals are the sum; the accounts are listed fullest first, each with its own amount.
    expect(balances.get(a.yesMint.toBase58())).toEqual({
      amount: 10n,
      accounts: [
        { account: accounts[1]?.toBase58(), amount: 6n },
        { account: accounts[0]?.toBase58(), amount: 4n },
      ],
    });
    expect(holdingsFor(balances, [NVDA, AAPL], programId)).toEqual({
      [NVDA.address]: {
        yes: 10n,
        no: 2n,
        yesAccounts: [
          { account: accounts[1]?.toBase58(), amount: 6n },
          { account: accounts[0]?.toBase58(), amount: 4n },
        ],
        noAccounts: [{ account: accounts[2]?.toBase58(), amount: 2n }],
      },
    });
  });

  it("rejects a malformed token-account response instead of guessing", async () => {
    await expect(
      fetchBalancesByMint(
        { getParsedTokenAccountsByOwner: () => Promise.resolve({ value: [{}] }) } as never,
        wallet,
      ),
    ).rejects.toThrow();
  });
});

describe("restingOrders", () => {
  it("returns only the owner's non-empty orders on each side", () => {
    const mine = Keypair.generate().publicKey;
    const theirs = Keypair.generate().publicKey;
    const order = (owner: PublicKey, price: number, qty: number, id: number) => ({
      orderId: { toString: () => String(id) },
      owner,
      price,
      qty: { toString: () => String(qty) },
    });
    const rows = restingOrders(
      "M",
      {
        bids: [order(mine, 40, 5, 1), order(theirs, 41, 5, 2), order(mine, 39, 0, 3)],
        asks: [order(mine, 60, 2, 4)],
      },
      mine,
    );
    expect(rows).toEqual([
      { market: "M", orderId: 1n, side: "Bid", price: 40, qty: 5n },
      { market: "M", orderId: 4n, side: "Ask", price: 60, qty: 2n },
    ]);
  });
});

describe("orderSignatures: oldest first, including inside one slot", () => {
  it("reverses each newest-first page so two fills in one slot keep their real order", () => {
    // RPC returns newest-first: `b` (a sell) landed after `a` (a buy), both in slot 10.
    const page = [
      { signature: "c", slot: 11 },
      { signature: "b", slot: 10 },
      { signature: "a", slot: 10 },
      { signature: "z", slot: 9 },
    ];
    expect(orderSignatures([page])).toEqual(["z", "a", "b", "c"]);
  });

  it("merges pages from several addresses: slots first, then each page's own order", () => {
    const wallet = [
      { signature: "w2", slot: 5 },
      { signature: "w1", slot: 5 },
    ];
    const openOrders = [
      { signature: "w2", slot: 5 },
      { signature: "m1", slot: 5 }, // a taker's fill against the maker's OpenOrders
      { signature: "w1", slot: 5 },
      { signature: "early", slot: 4 },
    ];
    // w1 < m1 < w2 is the only order both pages agree on.
    expect(orderSignatures([wallet, openOrders])).toEqual(["early", "w1", "m1", "w2"]);
  });

  it("an end-to-end fetch hands the decoder oldest-first events", async () => {
    const { connection: c, getTransactions } = connection(
      {
        [wallet.toBase58()]: [
          { signature: "second", slot: 10, err: null },
          { signature: "first", slot: 10, err: null },
        ],
      },
      { first: fixture.logs, second: fixture.logs },
    );
    const { events } = await fetchWalletEvents(c, [wallet], programId);
    expect(getTransactions.mock.calls[0]?.[0]).toEqual(["first", "second"]);
    expect([...new Set(events.map((event) => event.signature))]).toEqual(["first", "second"]);
  });
});
