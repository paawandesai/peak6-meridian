import { BN, BorshCoder } from "@coral-xyz/anchor";
import { MERIDIAN_IDL } from "@meridian/client";
import { Keypair, PublicKey } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  connectionOpenTimeRpc,
  createdMarkets,
  createOpenTimeIndex,
  MAX_PENDING_ATTEMPTS,
  marketsBody,
  marketsResponse,
  type IndexedTx,
  type OpenTimeIndex,
  type OpenTimeOptions,
  type OpenTimeRpc,
  type SignatureEntry,
} from "./openTimes";
import { recordingLogger } from "./testing/harness";

const PROGRAM = new PublicKey(MERIDIAN_IDL.address);
const AUTHORITY = Keypair.generate().publicKey;
const coder = new BorshCoder(MERIDIAN_IDL);

function key(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i) % 256));
}

function eventLog(name: string, data: object): string {
  const event = MERIDIAN_IDL.events?.find((candidate) => candidate.name === name);
  if (event === undefined) throw new Error(`no event ${name}`);
  const body = coder.types.encode(name, data);
  return `Program data: ${Buffer.concat([Buffer.from(event.discriminator), body]).toString("base64")}`;
}

function createdLog(market: PublicKey): string {
  return eventLog("MarketCreated", {
    market,
    ticker: [65, 65, 80, 76, 0, 0, 0, 0],
    strike_cents: new BN(23_000),
    trading_date: 20261009,
    close_ts: new BN(1_760_040_000),
    yes_mint: key(200),
    no_mint: key(201),
  });
}

function programLogs(lines: readonly string[], program: PublicKey = PROGRAM): string[] {
  return [
    `Program ${program.toBase58()} invoke [1]`,
    ...lines,
    `Program ${program.toBase58()} success`,
  ];
}

const NOW_SECS = 1_760_100_000;

function events(logger: ReturnType<typeof recordingLogger>, name: string) {
  return logger.lines.filter((line) => line.event === name);
}
const DAY = 86_400;

/** An in-memory history of the automation authority: newest first, like the RPC. */
class FakeRpc implements OpenTimeRpc {
  readonly history: (SignatureEntry & { tx: IndexedTx | null })[] = [];
  readonly signatureCalls: { address: string; before?: string; until?: string; limit: number }[] =
    [];
  readonly txCalls: string[][] = [];
  failTransactions = 0;
  /** Calls to `transactions` that succeed before `failTransactions` kicks in. */
  failAfter = 0;
  hangSignatures: Promise<never> | null = null;

  /** Adds a transaction as the newest one. */
  push(signature: string, blockTime: number | null, tx: IndexedTx | null, err: unknown = null) {
    this.history.unshift({ signature, blockTime, err, tx });
  }

  signatures: OpenTimeRpc["signatures"] = (address, options) => {
    this.signatureCalls.push({ address: address.toBase58(), ...options });
    if (this.hangSignatures !== null) return this.hangSignatures;
    let list = this.history;
    if (options.before !== undefined) {
      const at = list.findIndex((entry) => entry.signature === options.before);
      list = list.slice(at + 1);
    }
    if (options.until !== undefined) {
      const at = list.findIndex((entry) => entry.signature === options.until);
      if (at >= 0) list = list.slice(0, at);
    }
    return Promise.resolve(
      list
        .slice(0, options.limit)
        .map(({ signature, blockTime, err }) => ({ signature, blockTime, err })),
    );
  };

  transactions: OpenTimeRpc["transactions"] = (signatures) => {
    this.txCalls.push([...signatures]);
    if (this.failAfter > 0) {
      this.failAfter -= 1;
    } else if (this.failTransactions > 0) {
      this.failTransactions -= 1;
      return Promise.reject(new Error("rpc down at https://rpc.example/secret-key"));
    }
    return Promise.resolve(
      signatures.map(
        (signature) => this.history.find((e) => e.signature === signature)?.tx ?? null,
      ),
    );
  };
}

function creation(market: PublicKey, blockTime: number | null): IndexedTx {
  return { blockTime, meta: { logMessages: programLogs([createdLog(market)]) } };
}

const settlementTx = (blockTime: number): IndexedTx => ({
  blockTime,
  meta: { logMessages: programLogs(["Program log: Instruction: SettleMarket"]) },
});

function setup(options: Partial<OpenTimeOptions> = {}, rpc = new FakeRpc()) {
  let nowMs = NOW_SECS * 1_000;
  const logger = recordingLogger();
  const sleeps: number[] = [];
  let authorityReads = 0;
  let failAuthority = 0;
  const build = (): OpenTimeIndex =>
    createOpenTimeIndex({
      rpc,
      programId: PROGRAM,
      readAuthority: () => {
        authorityReads += 1;
        if (failAuthority > 0) {
          failAuthority -= 1;
          return Promise.reject(new Error("config unreadable"));
        }
        return Promise.resolve(AUTHORITY);
      },
      now: () => new Date(nowMs),
      log: logger.log,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      options: { minRefreshMs: 30_000, ...options },
    });
  return {
    rpc,
    logger,
    sleeps,
    build,
    index: build(),
    advance: (ms: number) => {
      nowMs += ms;
    },
    failAuthorityReads: (count: number) => {
      failAuthority = count;
    },
    authorityReads: () => authorityReads,
  };
}

describe("createdMarkets", () => {
  it("returns the market of a MarketCreated event", () => {
    expect(createdMarkets(programLogs([createdLog(key(1))]), PROGRAM)).toEqual([key(1).toBase58()]);
  });

  it("ignores other events, other programs and undecodable lines", () => {
    const fill = eventLog("PairsMinted", {
      market: key(1),
      user: key(2),
      qty: new BN(1),
      pairs_outstanding: new BN(1),
    });
    const other = Keypair.generate().publicKey;
    const logs = [
      ...programLogs([fill, "Program data: !!!not-base64", "Program data: AAAA"]),
      ...programLogs([createdLog(key(3))], other),
      ...programLogs([createdLog(key(4)).slice(0, 40), createdLog(key(5))]),
    ];
    expect(createdMarkets(logs, PROGRAM)).toEqual([key(5).toBase58()]);
    expect(createdMarkets([], PROGRAM)).toEqual([]);
  });

  it("never throws and never invents a market from arbitrary log lines (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.string(),
            fc
              .uint8Array({ maxLength: 200 })
              .map((bytes) => `Program data: ${Buffer.from(bytes).toString("base64")}`),
          ),
          { maxLength: 8 },
        ),
        (lines) => {
          expect(createdMarkets(programLogs(lines), PROGRAM)).toEqual([]);
        },
      ),
    );
  });

  it("decodes every encoded market, in order (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 6 }), (seeds) => {
        const markets = seeds.map((seed) => key(seed));
        expect(createdMarkets(programLogs(markets.map(createdLog)), PROGRAM)).toEqual(
          markets.map((market) => market.toBase58()),
        );
      }),
    );
  });
});

describe("open-time index: backfill", () => {
  it("indexes creations from one scan of the authority, never per market (AC)", async () => {
    const t = setup();
    t.rpc.push("old", NOW_SECS - 8 * DAY, creation(key(9), NOW_SECS - 8 * DAY));
    t.rpc.push("c1", NOW_SECS - 3_600, creation(key(1), NOW_SECS - 3_600));
    t.rpc.push("failed", NOW_SECS - 3_000, creation(key(7), NOW_SECS - 3_000), { err: 1 });
    t.rpc.push("c2", NOW_SECS - 1_800, creation(key(2), NOW_SECS - 1_800));
    t.rpc.push("settle", NOW_SECS - 60, settlementTx(NOW_SECS - 60));
    expect(t.index.snapshot()).toEqual({ ready: false, asOf: null, markets: [] });

    await t.index.refresh();

    const snapshot = t.index.snapshot();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.asOf).toBe(new Date(NOW_SECS * 1_000).toISOString());
    expect(new Map(snapshot.markets.map((e) => [e.market, e]))).toEqual(
      new Map([
        [
          key(1).toBase58(),
          { market: key(1).toBase58(), openedAt: NOW_SECS - 3_600, signature: "c1" },
        ],
        [
          key(2).toBase58(),
          { market: key(2).toBase58(), openedAt: NOW_SECS - 1_800, signature: "c2" },
        ],
      ]),
    );
    // Only the authority's history is scanned; failed and out-of-window transactions are not fetched.
    expect(new Set(t.rpc.signatureCalls.map((call) => call.address))).toEqual(
      new Set([AUTHORITY.toBase58()]),
    );
    expect(t.rpc.txCalls.flat().sort()).toEqual(["c1", "c2", "settle"]);
  });

  it("pages back through the history and batches transaction reads", async () => {
    const t = setup({ pageSize: 2, txBatch: 2, batchPauseMs: 7 });
    for (let i = 0; i < 5; i += 1) {
      t.rpc.push(`c${String(i)}`, NOW_SECS - 1_000 + i, creation(key(i), NOW_SECS - 1_000 + i));
    }
    await t.index.refresh();
    expect(t.index.snapshot().markets).toHaveLength(5);
    expect(t.rpc.signatureCalls.map((call) => call.before)).toEqual([undefined, "c3", "c1"]);
    expect(t.rpc.txCalls.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(t.sleeps).toEqual([7, 7]);
  });

  it("stops at maxPages and says the scan was truncated", async () => {
    const t = setup({ pageSize: 1, maxPages: 2 });
    for (let i = 0; i < 4; i += 1) {
      t.rpc.push(`c${String(i)}`, NOW_SECS - 100 + i, creation(key(i), NOW_SECS - 100 + i));
    }
    await t.index.refresh();
    expect(
      t.index
        .snapshot()
        .markets.map((e) => e.signature)
        .sort(),
    ).toEqual(["c2", "c3"]);
    expect(events(t.logger, "open_times_scan_truncated")).toHaveLength(1);
  });

  it("is rebuilt identically by a fresh index after a restart (durable)", async () => {
    const t = setup();
    t.rpc.push("c1", NOW_SECS - 7_200, creation(key(1), NOW_SECS - 7_200));
    t.rpc.push("c2", NOW_SECS - 3_600, creation(key(2), NOW_SECS - 3_600));
    await t.index.refresh();
    const before = t.index.snapshot().markets;

    const restarted = t.build();
    expect(restarted.snapshot().ready).toBe(false);
    await restarted.refresh();
    expect(restarted.snapshot().markets).toEqual(before);
  });

  it("keeps a market's first creation and an empty history is ready with no markets", async () => {
    const empty = setup();
    await empty.index.refresh();
    expect(empty.index.snapshot()).toMatchObject({ ready: true, markets: [] });

    const t = setup();
    t.rpc.push("c1", NOW_SECS - 100, creation(key(1), NOW_SECS - 100));
    t.rpc.push("again", NOW_SECS - 50, creation(key(1), NOW_SECS - 50));
    await t.index.refresh();
    expect(t.index.snapshot().markets).toEqual([
      { market: key(1).toBase58(), openedAt: NOW_SECS - 100, signature: "c1" },
    ]);
  });

  it("skips a transaction without logs", async () => {
    const t = setup();
    t.rpc.push("nolog", NOW_SECS - 10, { blockTime: NOW_SECS - 10, meta: null });
    t.rpc.push("nullog", NOW_SECS - 9, { blockTime: NOW_SECS - 9, meta: { logMessages: null } });
    await t.index.refresh();
    expect(t.index.snapshot()).toMatchObject({ ready: true, markets: [] });
  });
});

describe("open-time index: incremental refresh", () => {
  it("scans only signatures newer than the last one seen", async () => {
    const t = setup();
    t.rpc.push("c1", NOW_SECS - 100, creation(key(1), NOW_SECS - 100));
    await t.index.refresh();
    t.rpc.push("c2", NOW_SECS + 10, creation(key(2), NOW_SECS + 10));
    t.advance(60_000);
    await t.index.refresh();
    expect(t.rpc.signatureCalls.at(-1)?.until).toBe("c1");
    expect(t.rpc.txCalls.at(-1)).toEqual(["c2"]);
    expect(t.index.snapshot().markets).toHaveLength(2);
    // Nothing new: the cursor stays and nothing is fetched.
    t.advance(60_000);
    await t.index.refresh();
    expect(t.rpc.signatureCalls.at(-1)?.until).toBe("c2");
    expect(t.rpc.txCalls).toHaveLength(2);
  });

  it("refreshes at most once per minRefreshMs and shares a run in flight", async () => {
    const t = setup();
    await Promise.all([t.index.refreshIfStale(), t.index.refreshIfStale(), t.index.refresh()]);
    expect(t.rpc.signatureCalls).toHaveLength(1);
    await t.index.refreshIfStale();
    expect(t.rpc.signatureCalls).toHaveLength(1);
    t.advance(30_000);
    await t.index.refreshIfStale();
    expect(t.rpc.signatureCalls).toHaveLength(2);
  });

  it("resolves a signature the morning job noted on the very next request", async () => {
    const t = setup();
    await t.index.refresh();
    t.rpc.push("noted", NOW_SECS + 5, creation(key(3), NOW_SECS + 5));
    t.index.noteCreated("noted");
    t.index.noteCreated("noted");
    await t.index.refreshIfStale(); // within minRefreshMs, but a noted creation lifts the throttle
    expect(t.index.snapshot().markets.map((e) => e.signature)).toEqual(["noted"]);
    expect(t.rpc.txCalls.at(-1)).toEqual(["noted"]);
  });

  it("drops markets older than the lookback as time passes", async () => {
    const t = setup({ lookbackSecs: DAY });
    t.rpc.push("c1", NOW_SECS - 3_600, creation(key(1), NOW_SECS - 3_600));
    await t.index.refresh();
    expect(t.index.snapshot().markets).toHaveLength(1);
    t.advance(DAY * 1_000);
    await t.index.refresh();
    expect(t.index.snapshot().markets).toEqual([]);
  });
});

describe("open-time index: failures fail soft", () => {
  it("stays not-ready when the config is unreadable, logs it, and recovers later", async () => {
    const t = setup();
    t.rpc.push("c1", NOW_SECS - 100, creation(key(1), NOW_SECS - 100));
    t.failAuthorityReads(1);
    await t.index.refresh();
    expect(t.index.snapshot()).toEqual({ ready: false, asOf: null, markets: [] });
    expect(events(t.logger, "open_times_refresh_failed")).toHaveLength(1);
    t.advance(30_000);
    await t.index.refreshIfStale();
    expect(t.index.snapshot().ready).toBe(true);
    expect(t.authorityReads()).toBe(2);
    // The authority is read once and kept.
    t.advance(30_000);
    await t.index.refresh();
    expect(t.authorityReads()).toBe(2);
  });

  it("resumes a rate-limited backfill where it stopped, listing what it resolved, and never logs the URL", async () => {
    const t = setup({ txBatch: 1 });
    for (let i = 0; i < 3; i += 1) {
      t.rpc.push(`c${String(i)}`, NOW_SECS - 100 + i, creation(key(i), NOW_SECS - 100 + i));
    }
    t.rpc.failAfter = 1; // the first batch succeeds, the second is rate limited
    t.rpc.failTransactions = 1;
    await t.index.refresh();
    // Not ready, but the newest market already resolved is served.
    expect(t.index.snapshot().ready).toBe(false);
    expect(t.index.snapshot().markets.map((e) => e.signature)).toEqual(["c2"]);
    const failed = events(t.logger, "open_times_refresh_failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed)).not.toContain("rpc.example");
    expect(failed[0]?.fields).toMatchObject({ scanned: true, indexed: 1, pending: 2 });
    t.advance(30_000);
    await t.index.refresh();
    // The scan is not repeated from scratch; only the two left over are fetched.
    expect(t.rpc.signatureCalls.at(-1)?.until).toBe("c2");
    expect(t.rpc.txCalls.slice(2).flat()).toEqual(["c1", "c0"]);
    expect(t.index.snapshot().ready).toBe(true);
    expect(t.index.snapshot().markets).toHaveLength(3);
  });

  it("retries a transaction the node cannot return yet, then gives up after the cap", async () => {
    const t = setup();
    t.rpc.push("late", NOW_SECS - 10, null);
    await t.index.refresh();
    expect(t.index.snapshot().markets).toEqual([]);
    const entry = t.rpc.history[0];
    if (entry === undefined) throw new Error("fixture");
    entry.tx = creation(key(4), NOW_SECS - 10);
    t.advance(30_000);
    await t.index.refresh();
    expect(t.index.snapshot().markets.map((e) => e.signature)).toEqual(["late"]);

    const lost = setup();
    await lost.index.refresh();
    lost.index.noteCreated("dropped");
    for (let i = 0; i < MAX_PENDING_ATTEMPTS + 2; i += 1) {
      lost.advance(30_000);
      await lost.index.refresh();
    }
    const fetched = lost.rpc.txCalls.flat().filter((s) => s === "dropped");
    expect(fetched).toHaveLength(MAX_PENDING_ATTEMPTS);
  });

  it("records no time for a creation whose block time is not reported yet", async () => {
    const t = setup();
    t.rpc.push("c1", null, creation(key(1), null));
    await t.index.refresh();
    expect(t.index.snapshot().markets).toEqual([]);
    const entry = t.rpc.history[0];
    if (entry === undefined) throw new Error("fixture");
    entry.tx = creation(key(1), NOW_SECS - 5);
    t.advance(30_000);
    await t.index.refresh();
    expect(t.index.snapshot().markets).toEqual([
      { market: key(1).toBase58(), openedAt: NOW_SECS - 5, signature: "c1" },
    ]);
  });
});

describe("open-time index: startup backfill loop", () => {
  it("retries with doubling, capped waits until the backfill completes", async () => {
    const t = setup({ backfillRetryMs: 10, backfillRetryMaxMs: 25 });
    t.rpc.push("c1", NOW_SECS - 100, creation(key(1), NOW_SECS - 100));
    t.rpc.failTransactions = 3;
    await t.index.backfill();
    expect(t.index.snapshot().ready).toBe(true);
    expect(t.index.snapshot().markets).toHaveLength(1);
    expect(t.sleeps).toEqual([10, 20, 25]);
  });

  it("keeps the short wait while rate-limited attempts still make progress", async () => {
    const t = setup({ txBatch: 1, backfillRetryMs: 10, backfillRetryMaxMs: 1_000 });
    for (let i = 0; i < 3; i += 1) {
      t.rpc.push(`c${String(i)}`, NOW_SECS - 100 + i, creation(key(i), NOW_SECS - 100 + i));
    }
    // Attempt 1 resolves one then fails; attempt 2 fails at once; attempt 3 completes.
    t.rpc.failAfter = 1;
    t.rpc.failTransactions = 2;
    await t.index.backfill();
    expect(t.index.snapshot().ready).toBe(true);
    expect(t.index.snapshot().markets).toHaveLength(3);
    // txBatch pauses use the default batchPauseMs; the backfill waits are 10 then 20.
    expect(t.sleeps.filter((ms) => ms !== 2_000)).toEqual([10, 20]);
  });

  it("returns at once when the first attempt succeeds", async () => {
    const t = setup();
    await t.index.backfill();
    expect(t.index.snapshot().ready).toBe(true);
    expect(t.sleeps).toEqual([]);
  });

  it("ends when stopped, before or after a wait", async () => {
    const before = setup();
    before.rpc.failTransactions = 100;
    before.rpc.push("c1", NOW_SECS - 100, creation(key(1), NOW_SECS - 100));
    before.index.stop();
    await before.index.backfill();
    expect(before.index.snapshot().ready).toBe(false);
    expect(before.rpc.txCalls).toHaveLength(1);

    let index: OpenTimeIndex | null = null;
    const rpc = new FakeRpc();
    rpc.failTransactions = 100;
    rpc.push("c1", NOW_SECS - 100, creation(key(1), NOW_SECS - 100));
    index = createOpenTimeIndex({
      rpc,
      programId: PROGRAM,
      readAuthority: () => Promise.resolve(AUTHORITY),
      now: () => new Date(NOW_SECS * 1_000),
      log: recordingLogger().log,
      sleep: () => {
        index?.stop();
        return Promise.resolve();
      },
    });
    await index.backfill();
    expect(rpc.txCalls).toHaveLength(1);
  });
});

describe("GET /markets body", () => {
  it("is snake_case with integer unix seconds", () => {
    expect(
      marketsBody({
        ready: true,
        asOf: "2026-10-09T12:00:00.000Z",
        markets: [{ market: "M", openedAt: 1_760_000_000, signature: "s" }],
      }),
    ).toEqual({
      ready: true,
      as_of: "2026-10-09T12:00:00.000Z",
      markets: [{ market: "M", opened_at: 1_760_000_000, signature: "s" }],
    });
  });

  it("answers within the wait with what the index holds while a refresh hangs", async () => {
    const t = setup();
    t.rpc.hangSignatures = new Promise<never>(() => undefined);
    const started = Date.now();
    const body = await marketsResponse(t.index, 20);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(body).toEqual({ ready: false, as_of: null, markets: [] });
  });

  it("includes what a quick refresh found", async () => {
    const t = setup();
    t.rpc.push("c1", NOW_SECS - 100, creation(key(1), NOW_SECS - 100));
    const body = await marketsResponse(t.index, 1_000);
    expect(body.ready).toBe(true);
    expect(body.markets).toEqual([
      { market: key(1).toBase58(), opened_at: NOW_SECS - 100, signature: "c1" },
    ]);
  });
});

describe("connectionOpenTimeRpc", () => {
  it("reads at confirmed commitment with versioned transactions", async () => {
    const calls: unknown[][] = [];
    const connection = {
      getSignaturesForAddress: (...args: unknown[]) => {
        calls.push(["sigs", ...args]);
        return Promise.resolve([]);
      },
      getTransactions: (...args: unknown[]) => {
        calls.push(["txs", ...args]);
        return Promise.resolve([]);
      },
    } as unknown as Parameters<typeof connectionOpenTimeRpc>[0];
    const rpc = connectionOpenTimeRpc(connection);
    await rpc.signatures(AUTHORITY, { limit: 5, until: "u" });
    await rpc.transactions(["a"]);
    expect(calls).toEqual([
      ["sigs", AUTHORITY, { limit: 5, until: "u" }, "confirmed"],
      ["txs", ["a"], { maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
    ]);
  });
});
