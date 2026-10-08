// AB-04 · Settle with a spoofed oracle account or a different feed (threat-model.md; NFR-06;
// M2-04 AC6). Off-chain: the transaction builder only ever passes the Config-pinned feeds of the
// market's own ticker. On-chain (local validator, inside `make e2e`): a different, unpinned or
// swapped feed account, or one with the wrong owner, is rejected by the program.
import { Keypair, PublicKey } from "@solana/web3.js";
import { runSettlement } from "automation";
import { SettleWorld } from "automation/testing";
import { describe, expect, it } from "vitest";

import {
  createMarket,
  localFeedPda,
  SKIP_REASON,
  setLocalFeed,
  trySettle,
  validatorSession,
  waitUntil,
} from "./validator";

const CLOSE_TS = 1_791_316_800;

describe("AB-04 off-chain: the builder passes only the Config-pinned feeds", () => {
  it("every settle_market names exactly the pinned Tiingo and Twelve Data feed of its own ticker", async () => {
    const w = new SettleWorld({
      markets: [
        { ticker: "META", strike: 680 },
        { ticker: "META", strike: 700 },
        { ticker: "AAPL", strike: 230 },
      ],
      closeTs: CLOSE_TS,
      start: new Date((CLOSE_TS + 300) * 1_000),
    });
    // META and AAPL pin different feeds.
    const meta: [PublicKey, PublicKey] = [
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    ];
    const aapl: [PublicKey, PublicKey] = [
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    ];
    w.pinned = { feeds: { META: meta, AAPL: aapl }, maxStalenessSlots: 30 };
    // Only pinned feeds can be updated: the recorded update has no entry for these accounts, so
    // use an adapter that records the feeds it was asked for.
    const asked: string[] = [];
    const deps = w.deps({
      adapter: {
        kind: "switchboard",
        build: (request) => {
          asked.push(...request.feeds.map((f) => f.toBase58()));
          return Promise.resolve({ ixs: [], luts: [], signers: [] });
        },
      },
    });
    expect((await runSettlement(deps)).status).toBe("ok");

    const settles = w.executor.sent
      .flatMap((s) => s.tx.instructions)
      .filter((ix) => ix.programId.equals(w.program.programId));
    expect(settles).toHaveLength(3);
    const pairs = settles.map((ix) => [
      ix.keys[2]?.pubkey.toBase58(),
      ix.keys[3]?.pubkey.toBase58(),
    ]);
    const metaPair = [meta[0].toBase58(), meta[1].toBase58()];
    const aaplPair = [aapl[0].toBase58(), aapl[1].toBase58()];
    expect(pairs.filter((p) => p[0] === metaPair[0] && p[1] === metaPair[1])).toHaveLength(2);
    expect(pairs.filter((p) => p[0] === aaplPair[0] && p[1] === aaplPair[1])).toHaveLength(1);
    // The oracle update was likewise requested only for pinned feeds.
    const pinned = new Set([...metaPair, ...aaplPair]);
    expect(asked.every((feed) => pinned.has(feed))).toBe(true);
  });

  it("a ticker with no pinned feeds is never settled with improvised ones", async () => {
    const w = new SettleWorld({
      markets: [{ ticker: "MSFT", strike: 440 }],
      closeTs: CLOSE_TS,
      start: new Date((CLOSE_TS + 300) * 1_000),
    });
    w.closes = { MSFT: 41_500 };
    const result = await runSettlement(w.deps({ options: { ...w.deps().options, windowMs: 0 } }));
    expect(result.status).toBe("failed");
    expect(w.executor.sent).toEqual([]);
  });
});

const v = validatorSession();
describe.runIf(v !== null)(
  "AB-04 on-chain (local validator): the program rejects an unpinned or spoofed feed",
  () => {
    it(
      "rejects another ticker's feeds, swapped feeds and a wrongly owned account",
      { timeout: 180_000 },
      async () => {
        if (v === null) {
          throw new Error(SKIP_REASON);
        }
        const { market, closeTs } = await createMarket(v, 15);
        const meta: [PublicKey, PublicKey] = [
          localFeedPda(v.programId, "META", 0),
          localFeedPda(v.programId, "META", 1),
        ];
        const tsla: [PublicKey, PublicKey] = [
          localFeedPda(v.programId, "TSLA", 0),
          localFeedPda(v.programId, "TSLA", 1),
        ];
        await waitUntil(v, closeTs);
        const slot = await v.connection.getSlot("confirmed");
        // Real, program-owned LocalFeeds with fresh values exist for both tickers ...
        for (const symbol of ["META", "TSLA"]) {
          await setLocalFeed(v, symbol, 0, 68_000n, slot);
          await setLocalFeed(v, symbol, 1, 68_000n, slot);
        }
        // ... but the market's Config pins META's only.
        expect(await trySettle(v, market, tsla)).toBe("OracleFeedHashMismatch");
        expect(await trySettle(v, market, [meta[1], meta[0]])).toBe("OracleFeedHashMismatch");
        expect(await trySettle(v, market, [meta[0], tsla[1]])).toBe("OracleFeedHashMismatch");
        // An account the program does not own (here the admin's wallet) is no feed at all.
        expect(await trySettle(v, market, [v.admin.publicKey, meta[1]])).toBe("OracleWrongOwner");
        // And the market is untouched: the pinned feeds still settle it.
        expect(await trySettle(v, market, meta)).toBe("settled");
      },
    );
  },
);
describe.skipIf(v !== null)("AB-04 on-chain (local validator)", () => {
  it.skip(SKIP_REASON, () => undefined);
});
