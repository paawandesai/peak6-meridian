import * as fc from "fast-check";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { switchboardAdapter } from "./switchboard";
import {
  buildSettleInstructions,
  MAX_TX_BYTES,
  planSettlement,
  sendPlan,
  type PlannedTx,
  type SettlementPlan,
} from "./settleTx";
import { FakeExecutor, loadUpdateFixture, SettleWorld } from "./testing";

const CLOSE_TS = 1_791_316_800; // 2026-10-06 16:00 ET

function world(markets: number): SettleWorld {
  return new SettleWorld({
    markets: Array.from({ length: markets }, (_, i) => ({ ticker: "META", strike: 600 + i * 10 })),
    closeTs: CLOSE_TS,
    start: new Date((CLOSE_TS + 300) * 1_000),
  });
}

async function setup(markets: number, feedsInUpdate: 1 | 2) {
  const w = world(markets);
  const fx = w.update;
  const update =
    feedsInUpdate === 2
      ? await switchboardAdapter(fx.fetchUpdate).build({
          ticker: "META",
          closeCents: 68_000,
          feeds: fx.feeds,
          slot: 1,
        })
      : { ...(await fx.fetchUpdate(fx.feeds[0])), signers: [] };
  const settleIxs = await buildSettleInstructions({
    program: w.program,
    config: w.config,
    payer: w.payer.publicKey,
    markets: w.open.map((m) => m.address),
    feeds: fx.feeds,
  });
  return { w, fx, update, settleIxs };
}

describe("buildSettleInstructions (AC4, AB-04)", () => {
  it("passes exactly the Config-pinned feeds, in order, and the payer as the only signer", async () => {
    const { w, fx, settleIxs } = await setup(3, 2);
    expect(settleIxs).toHaveLength(3);
    settleIxs.forEach((ix, i) => {
      expect(ix.programId.equals(w.program.programId)).toBe(true);
      expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
        w.config.toBase58(),
        w.open[i]?.address.toBase58(),
        fx.feeds[0].toBase58(),
        fx.feeds[1].toBase58(),
        w.payer.publicKey.toBase58(),
      ]);
      expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
        w.payer.publicKey.toBase58(),
      ]);
      expect(ix.keys[1]?.isWritable).toBe(true);
    });
  });
});

describe("planSettlement: the three shapes (AC4, AC5)", () => {
  it("one transaction when everything fits, feed update before settle_market", async () => {
    const { w, fx, update, settleIxs } = await setup(1, 1);
    const plan = planSettlement({
      payer: w.payer.publicKey,
      updateIxs: update.ixs,
      luts: update.luts,
      settleIxs,
    });
    expect(plan.shape).toBe("single");
    const ixs = plan.txs[0]?.instructions ?? [];
    const firstSettle = ixs.findIndex((ix) => ix.programId.equals(w.program.programId));
    expect(firstSettle).toBe(update.ixs.length);
    expect(ixs.slice(0, firstSettle).every((ix) => !ix.programId.equals(w.program.programId))).toBe(
      true,
    );
    expect(ixs.slice(0, firstSettle).some((ix) => ix.programId.equals(fx.switchboardProgram))).toBe(
      true,
    );
    expect(plan.txs[0]?.size).toBeLessThanOrEqual(MAX_TX_BYTES);
  });

  it("a versioned transaction with the update's lookup table when the legacy one is too big", async () => {
    const { w, update, settleIxs } = await setup(7, 1);
    const plan = planSettlement({
      payer: w.payer.publicKey,
      updateIxs: update.ixs,
      luts: update.luts,
      settleIxs,
    });
    expect(plan.shape).toBe("single-v0");
    expect(plan.txs).toHaveLength(1);
    expect(plan.txs[0]?.versioned).toBe(true);
    expect(plan.txs[0]?.size).toBeLessThanOrEqual(MAX_TX_BYTES);
  });

  it("splits a 7-market ticker with both feeds into an update transaction and settle transactions", async () => {
    const { w, update, settleIxs } = await setup(7, 2);
    expect(update.ixs).toHaveLength(4);
    const plan = planSettlement({
      payer: w.payer.publicKey,
      updateIxs: update.ixs,
      luts: update.luts,
      settleIxs,
    });
    expect(plan.shape).toBe("split");
    const [first, ...rest] = plan.txs;
    expect(first?.role).toBe("update");
    expect(first?.instructions).toEqual(update.ixs);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((tx) => tx.role === "settle")).toBe(true);
    for (const tx of plan.txs) {
      expect(tx.size).toBeLessThanOrEqual(MAX_TX_BYTES);
    }
    // Every market is settled exactly once, in order, and no settle tx carries an update.
    const settled = rest.flatMap((tx) => tx.instructions);
    expect(settled).toEqual(settleIxs);
    expect(
      rest.every((tx) => tx.instructions.every((ix) => ix.programId.equals(w.program.programId))),
    ).toBe(true);
  });

  it("packs many markets into as few settle transactions as fit", async () => {
    const { w, update, settleIxs } = await setup(40, 2);
    const plan = planSettlement({
      payer: w.payer.publicKey,
      updateIxs: update.ixs,
      luts: update.luts,
      settleIxs,
    });
    expect(plan.shape).toBe("split");
    const settleTxs = plan.txs.filter((tx) => tx.role === "settle");
    expect(settleTxs.length).toBeGreaterThan(1);
    expect(settleTxs.reduce((n, tx) => n + tx.settles, 0)).toBe(40);
    expect(plan.txs.every((tx) => tx.size <= MAX_TX_BYTES)).toBe(true);
  });

  it("fails loudly when even a single instruction cannot fit", async () => {
    const { w, update, settleIxs } = await setup(1, 2);
    const huge = new TransactionInstruction({
      programId: update.ixs[0]?.programId ?? w.payer.publicKey,
      keys: [],
      data: Buffer.alloc(2_000),
    });
    expect(() =>
      planSettlement({ payer: w.payer.publicKey, updateIxs: [huge], luts: [], settleIxs }),
    ).toThrow(/oracle update alone/);
    expect(() =>
      planSettlement({
        payer: w.payer.publicKey,
        updateIxs: update.ixs,
        luts: update.luts,
        settleIxs: [huge, ...settleIxs],
      }),
    ).toThrow(/does not fit/);
  });
});

/**
 * A refresher like the job's: it builds a NEW update transaction at the executor's current slot
 * (a copy of the planned one, tagged with the slot it was built at in `builtAt`).
 */
function refresher(executor: FakeExecutor, plan: SettlementPlan, builtAt: Map<PlannedTx, number>) {
  return () => {
    const base = plan.txs[0];
    if (base === undefined) {
      return Promise.reject(new Error("no update in the plan"));
    }
    const fresh: PlannedTx = { ...base, instructions: [...base.instructions] };
    builtAt.set(fresh, executor.slot);
    return Promise.resolve({ tx: fresh, signers: [] });
  };
}

/** Records at which slot each transaction was sent. */
async function splitPlan(markets = 40) {
  const { w, update, settleIxs } = await setup(markets, 2);
  const plan = planSettlement({
    payer: w.payer.publicKey,
    updateIxs: update.ixs,
    luts: update.luts,
    settleIxs,
  });
  return { w, plan };
}

describe("sendPlan: the 30-slot staleness budget (AC5)", () => {
  const BUDGET = 20; // max_staleness_slots 30 minus the safety margin

  it("sends the update, then the settles, when the slots stay within the budget", async () => {
    const { w, plan } = await splitPlan();
    const executor = new FakeExecutor(w.program.programId);
    const builtAt = new Map<PlannedTx, number>();
    const report = await sendPlan({
      plan,
      executor,
      signers: [],
      budgetSlots: BUDGET,
      refreshUpdate: refresher(executor, plan, builtAt),
    });
    expect(report.reUpdates).toBe(0);
    expect(executor.sent.map((s) => s.tx.role)).toEqual(plan.txs.map((t) => t.role));
  });

  it("re-sends the feed update when the slot gap exceeds the budget, never a stale settle", async () => {
    const { w, plan } = await splitPlan();
    const executor = new FakeExecutor(w.program.programId);
    // The first send is the update (1 slot); the next send takes 40 slots: the second settle
    // transaction would run 40 slots after the update, so the update must go out again first.
    executor.advancePerSend = (index) => (index === 1 ? 40 : 1);
    const builtAt = new Map<PlannedTx, number>();
    const report = await sendPlan({
      plan,
      executor,
      signers: [],
      budgetSlots: BUDGET,
      refreshUpdate: refresher(executor, plan, builtAt),
    });
    expect(report.reUpdates).toBe(1);
    // The second update is a NEW transaction built at the later slot, not the old payload again.
    const updates = executor.sent.filter((s) => s.tx.role === "update");
    expect(updates).toHaveLength(2);
    expect(updates[1]?.tx).not.toBe(plan.txs[0]);
    expect(builtAt.get(updates[1]?.tx as PlannedTx)).toBeGreaterThan(updates[0]?.slot ?? Infinity);
    const roles = executor.sent.map((s) => s.tx.role);
    expect(roles.slice(0, 4)).toEqual(["update", "settle", "update", "settle"]);
    // Every settle was sent within the budget of the update that preceded it.
    let updatedAt = 0;
    let before = executor.slot;
    executor.sent.forEach((sent, i) => {
      before = i === 0 ? 1_000 : (executor.sent[i - 1]?.slot ?? before);
      if (sent.tx.role === "update") {
        updatedAt = sent.slot;
      } else {
        expect(before - updatedAt).toBeLessThanOrEqual(BUDGET);
      }
    });
  });

  it("gives up instead of looping when the update keeps going stale", async () => {
    const { w, plan } = await splitPlan(80);
    const executor = new FakeExecutor(w.program.programId);
    executor.advancePerSend = () => 50;
    await expect(
      sendPlan({
        plan,
        executor,
        signers: [],
        budgetSlots: BUDGET,
        maxReUpdates: 1,
        refreshUpdate: refresher(executor, plan, new Map()),
      }),
    ).rejects.toThrow(/keeps going stale/);
    expect(executor.sent.filter((s) => s.tx.role === "update").length).toBeLessThanOrEqual(2);
  });

  it("property: no settle transaction is ever sent more than the budget after its update", async () => {
    const { w, plan } = await splitPlan();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 45 }), { minLength: 1, maxLength: 12 }),
        async (gaps) => {
          const executor = new FakeExecutor(w.program.programId);
          executor.advancePerSend = (index) => gaps[index % gaps.length] ?? 1;
          const startSlot = executor.slot;
          const slotBefore: number[] = [];
          const send = executor.send;
          executor.send = (tx: PlannedTx, signers) => {
            slotBefore.push(executor.slot);
            return send(tx, signers);
          };
          try {
            await sendPlan({
              plan,
              executor,
              signers: [],
              budgetSlots: BUDGET,
              maxReUpdates: 50,
              refreshUpdate: refresher(executor, plan, new Map()),
            });
          } catch {
            // Giving up is allowed; sending a stale settle is not.
          }
          let updatedAt = startSlot;
          executor.sent.forEach((sent, i) => {
            if (sent.tx.role === "update") {
              updatedAt = sent.slot;
            } else {
              expect((slotBefore[i] ?? 0) - updatedAt).toBeLessThanOrEqual(BUDGET);
            }
          });
        },
      ),
      { numRuns: 60 },
    );
  });

  it("a single transaction is sent once and never needs a re-update", async () => {
    const { w, update, settleIxs } = await setup(1, 1);
    const plan = planSettlement({
      payer: w.payer.publicKey,
      updateIxs: update.ixs,
      luts: update.luts,
      settleIxs,
    });
    const executor = new FakeExecutor(w.program.programId);
    executor.advancePerSend = () => 500;
    expect(
      await sendPlan({
        plan,
        executor,
        signers: [],
        budgetSlots: BUDGET,
        refreshUpdate: () => Promise.reject(new Error("unused")),
      }),
    ).toMatchObject({
      reUpdates: 0,
      signatures: ["sig-0"],
    });
  });

  it("an empty plan sends nothing", async () => {
    const executor = new FakeExecutor(Keypair.generate().publicKey);
    expect(
      await sendPlan({
        plan: { shape: "single", txs: [] },
        executor,
        signers: [],
        budgetSlots: 1,
        refreshUpdate: () => Promise.reject(new Error("unused")),
      }),
    ).toEqual({
      signatures: [],
      reUpdates: 0,
    });
    expect(
      await sendPlan({
        plan: { shape: "split", txs: [] },
        executor,
        signers: [],
        budgetSlots: 1,
        refreshUpdate: () => Promise.reject(new Error("unused")),
      }),
    ).toEqual({
      signatures: [],
      reUpdates: 0,
    });
    expect(new PublicKey(loadUpdateFixture().switchboardProgram)).toBeInstanceOf(PublicKey);
  });
});
