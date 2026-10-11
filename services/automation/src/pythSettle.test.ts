import type { Program } from "@coral-xyz/anchor";
import { BN, type Meridian, symbolBytes } from "@meridian/client";
import { Ed25519Program, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { runSettlement } from "./jobs/settle";
import type { SignedPythUpdate } from "./pythLazer";
import {
  buildPythSettleInstructions,
  createPythSettler,
  ED25519_IX_INDEX,
  planPythSettlement,
  pythEd25519Ix,
  readPythConfig,
  type PythChainConfig,
} from "./pythSettle";
import { MAX_TX_BYTES } from "./settleTx";
import { pythTestSigner, SettleWorld, signedPythUpdate } from "./testing";

const CLOSE_TS = 1_791_316_800; // 2026-10-06 16:00 ET, the harness trading date
const META = 1272;
const signer = pythTestSigner();

function world(markets: number): SettleWorld {
  return new SettleWorld({
    markets: Array.from({ length: markets }, (_, i) => ({ ticker: "META", strike: 600 + i * 10 })),
    closeTs: CLOSE_TS,
    start: new Date((CLOSE_TS + 300) * 1_000),
  });
}

const chainConfig = (overrides: Partial<PythChainConfig> = {}): PythChainConfig => ({
  signer: signer.publicKey,
  feedIds: { META, AAPL: 922 },
  closeWindowSecs: 60,
  maxConfBps: 5,
  ...overrides,
});

const updateAt = (timestampSecs: number, overrides: { confidence?: bigint } = {}) =>
  signedPythUpdate(signer, {
    feedId: META,
    timestampUs: BigInt(timestampSecs) * 1_000_000n,
    price: 68_125_000_000n,
    confidence: overrides.confidence ?? 2_000_000n,
  });

/** A settler over the world's fake executor; records every Pyth request. */
function settlerFor(
  w: SettleWorld,
  options: {
    config?: PythChainConfig;
    fetch?: (feedId: number, timestampUs: bigint) => Promise<SignedPythUpdate>;
  } = {},
) {
  const requests: { feedId: number; timestampUs: bigint }[] = [];
  const settler = createPythSettler({
    readConfig: () => Promise.resolve(options.config ?? chainConfig()),
    fetchSigned: (feedId, timestampUs) => {
      requests.push({ feedId, timestampUs });
      return (
        options.fetch?.(feedId, timestampUs) ??
        Promise.resolve(updateAt(Number(timestampUs / 1_000_000n)))
      );
    },
    buildSettleIxs: (markets, feeds) =>
      buildPythSettleInstructions({
        program: w.program,
        config: w.config,
        payer: w.payer.publicKey,
        markets: markets.map((m) => m.address),
        feeds,
      }),
    payer: w.payer.publicKey,
    executor: w.executor,
    now: w.clock.now,
  });
  return { settler, requests };
}

describe("buildPythSettleInstructions", () => {
  it("passes the instructions sysvar and Ed25519 index 0, no RedStone accounts", async () => {
    const w = world(1);
    const [ix] = await buildPythSettleInstructions({
      program: w.program,
      config: w.config,
      payer: w.payer.publicKey,
      markets: [w.open[0]?.address ?? PublicKey.default],
      feeds: w.update.feeds,
    });
    expect(ix?.keys.map((k) => k.pubkey.toBase58())).toEqual([
      w.config.toBase58(),
      w.open[0]?.address.toBase58(),
      w.update.feeds[0].toBase58(),
      w.update.feeds[1].toBase58(),
      w.program.programId.toBase58(), // redstonePrice: none
      w.program.programId.toBase58(), // oracleConfig: none
      SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(),
      w.payer.publicKey.toBase58(),
    ]);
    // settle_market(Some(0)): discriminator, then Option tag 1 and u16 LE 0.
    expect([...(ix?.data.subarray(8) ?? [])]).toEqual([1, ED25519_IX_INDEX, 0]);
  });
});

describe("pythEd25519Ix", () => {
  it("embeds the signer, the signature and exactly the signed payload, all in-instruction", () => {
    const update = updateAt(CLOSE_TS);
    const ix = pythEd25519Ix(update);
    expect(ix.programId.equals(Ed25519Program.programId)).toBe(true);
    const data = Buffer.from(ix.data);
    // One signature; every instruction index is u16::MAX ("this instruction").
    expect(data[0]).toBe(1);
    for (const at of [4, 8, 14]) {
      expect(data.readUInt16LE(at)).toBe(0xffff);
    }
    const pubkeyAt = data.readUInt16LE(6);
    const messageAt = data.readUInt16LE(10);
    const messageLength = data.readUInt16LE(12);
    expect(data.subarray(pubkeyAt, pubkeyAt + 32).equals(signer.publicKey.toBuffer())).toBe(true);
    expect(data.subarray(messageAt, messageAt + messageLength).equals(update.payload)).toBe(true);
  });
});

describe("planPythSettlement", () => {
  it("puts the Ed25519 instruction first in every transaction and covers each settle once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 30 }), async (n) => {
        const w = world(n);
        const settles = await buildPythSettleInstructions({
          program: w.program,
          config: w.config,
          payer: w.payer.publicKey,
          markets: w.open.map((m) => m.address),
          feeds: w.update.feeds,
        });
        const ed = pythEd25519Ix(updateAt(CLOSE_TS));
        const txs = planPythSettlement(w.payer.publicKey, ed, settles);
        expect(txs.flatMap((tx) => tx.instructions.slice(1))).toEqual(settles);
        for (const tx of txs) {
          expect(tx.instructions[0]).toBe(ed);
          expect(tx.size).toBeLessThanOrEqual(MAX_TX_BYTES);
          expect(tx.settles).toBe(tx.instructions.length - 1);
        }
      }),
      { numRuns: 8 },
    );
  });

  it("returns nothing for no markets", () => {
    const w = world(1);
    expect(planPythSettlement(w.payer.publicKey, pythEd25519Ix(updateAt(CLOSE_TS)), [])).toEqual(
      [],
    );
  });
});

describe("createPythSettler", () => {
  it("fetches the update signed at close_ts and settles every market of the group", async () => {
    const w = world(3);
    const { settler, requests } = settlerFor(w);
    const reports = await settler.settle(w.open, w.update.feeds);
    expect(requests).toEqual([{ feedId: META, timestampUs: BigInt(CLOSE_TS) * 1_000_000n }]);
    expect(reports).toEqual([
      expect.objectContaining({ closeTs: CLOSE_TS, markets: 3, priceCents: 68_125n }),
    ]);
    expect(w.open).toEqual([]);
    for (const sent of w.executor.sent) {
      expect(sent.tx.instructions[0]?.programId.equals(Ed25519Program.programId)).toBe(true);
      expect(sent.signers).toEqual([]);
    }
  });

  it("uses one signed update per distinct close_ts in a group", async () => {
    const w = world(2);
    const first = w.open[0];
    if (first !== undefined) {
      w.open[0] = { ...first, closeTs: CLOSE_TS - 3_600 };
    }
    const { settler, requests } = settlerFor(w);
    expect(await settler.settle(w.open, w.update.feeds)).toHaveLength(2);
    expect(requests.map((r) => r.timestampUs)).toEqual([
      BigInt(CLOSE_TS - 3_600) * 1_000_000n,
      BigInt(CLOSE_TS) * 1_000_000n,
    ]);
  });

  it("refuses to run before update_config has set the signer, the window and the feed", async () => {
    const w = world(1);
    for (const [config, message] of [
      [chainConfig({ signer: PublicKey.default }), /pyth_lazer_signer is not set/],
      [chainConfig({ closeWindowSecs: 0 }), /pyth_max_age_secs is not set/],
      [chainConfig({ feedIds: { AAPL: 922 } }), /no Pyth feed id in the Config for META/],
    ] as const) {
      const { settler, requests } = settlerFor(w, { config });
      await expect(settler.settle(w.open, w.update.feeds)).rejects.toThrow(message);
      expect(requests).toEqual([]);
    }
    expect(w.executor.sent).toEqual([]);
  });

  it("sends nothing when the update breaks a settle_market rule", async () => {
    const w = world(1);
    const { settler } = settlerFor(w, {
      fetch: () => Promise.resolve(updateAt(CLOSE_TS, { confidence: 10n ** 9n })),
    });
    await expect(settler.settle(w.open, w.update.feeds)).rejects.toThrow(/wider than 5 bps/);
    const impostor = settlerFor(w, {
      config: chainConfig({ signer: Keypair.generate().publicKey }),
    });
    await expect(impostor.settler.settle(w.open, w.update.feeds)).rejects.toThrow(/pinned/);
    expect(w.executor.sent).toEqual([]);
    expect(w.open).toHaveLength(1);
  });

  it("does nothing for an empty group", async () => {
    const w = world(1);
    const { settler, requests } = settlerFor(w);
    expect(await settler.settle([], w.update.feeds)).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe("readPythConfig", () => {
  it("maps feed ids by ticker slot and skips unset slots", async () => {
    const symbol = (s: string) => Array.from(symbolBytes(s));
    const empty = Array.from(new Uint8Array(8));
    const pinned = Keypair.generate().publicKey;
    const program = {
      account: {
        config: {
          fetch: () =>
            Promise.resolve({
              tickers: [{ symbol: symbol("AAPL") }, { symbol: symbol("META") }, { symbol: empty }],
              pythFeedIds: [922, 0, 1163],
              pythLazerSigner: pinned,
              pythMaxAgeSecs: new BN(60),
              maxConfBps: 5,
            }),
        },
      },
    } as unknown as Program<Meridian>;
    expect(await readPythConfig(program, PublicKey.default)).toEqual({
      signer: pinned,
      feedIds: { AAPL: 922 },
      closeWindowSecs: 60,
      maxConfBps: 5,
    });
  });
});

describe("the settlement job with Pyth enabled (PYTH_SETTLEMENT_ENABLED=true)", () => {
  it("settles from Pyth after the date check, never builds an oracle update, logs both closes", async () => {
    const w = world(2);
    let adapterCalls = 0;
    const adapter = w.adapter();
    const { settler } = settlerFor(w);
    const result = await runSettlement(
      w.deps({
        pyth: settler,
        adapter: { kind: adapter.kind, build: (r) => ((adapterCalls += 1), adapter.build(r)) },
      }),
    );
    expect(result).toMatchObject({ status: "ok", settled: 2 });
    expect(adapterCalls).toBe(0);
    expect(w.verifyCalls).toEqual([{ ticker: "META", date: "2026-10-06" }]);
    const settled = w.logger.lines.find((l) => l.event === "settled");
    expect(settled?.fields).toMatchObject({
      source: "pyth",
      pythCents: 68_125,
      officialCents: 68_000,
      pythVsOfficialBps: 18.38,
    });
  });

  it("does not ask Pyth when the date check fails (AB-03)", async () => {
    const w = world(1);
    w.sourceDate = "2026-10-05";
    const { settler, requests } = settlerFor(w);
    expect((await runSettlement(w.deps({ pyth: settler }))).status).toBe("failed");
    expect(requests).toEqual([]);
    expect(w.executor.sent).toEqual([]);
  });

  it("a Pyth failure goes through the usual retry and alert path", async () => {
    const w = world(1);
    const { settler } = settlerFor(w, {
      fetch: () =>
        Promise.reject(new Error("pyth feed 1272 at 0µs: HTTP 404 (no update at that time)")),
    });
    const result = await runSettlement(
      w.deps({ pyth: settler, options: { ...w.deps().options, windowMs: 0 } }),
    );
    expect(result.status).toBe("failed");
    expect(result.failures[0]?.reason).toMatch(/HTTP 404/);
    expect(w.alerter.alerts.map((a) => a.kind)).toEqual(["settlement_failed"]);
    expect(w.open).toHaveLength(1);
  });

  it("is off by default: without `pyth` the oracle update path runs as before", async () => {
    const w = world(1);
    let adapterCalls = 0;
    const adapter = w.adapter();
    const result = await runSettlement(
      w.deps({
        adapter: { kind: adapter.kind, build: (r) => ((adapterCalls += 1), adapter.build(r)) },
      }),
    );
    expect(result).toMatchObject({ status: "ok", settled: 1 });
    expect(adapterCalls).toBe(1);
    const settles = w.executor.sent
      .flatMap((s) => s.tx.instructions)
      .filter((ix) => ix.programId.equals(w.program.programId));
    // settle_market(None): no Ed25519 index, no instructions sysvar.
    expect(settles.map((ix) => ix.data[8])).toEqual([0]);
  });
});
