import { BN, BorshCoder } from "@coral-xyz/anchor";
import { MERIDIAN_IDL, MERIDIAN_PROGRAM_ID } from "@meridian/client";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  decodeLogs,
  type EvidenceRpc,
  findRedeems,
  findSettlement,
  type SignatureInfo,
} from "./settlement-evidence-rpc";

const coder = new BorshCoder(MERIDIAN_IDL);
const programId = MERIDIAN_PROGRAM_ID;

/** A real transaction log carrying `name` encoded exactly as the program emits it. */
function logsWith(name: string, data: Record<string, unknown>): string[] {
  const event = MERIDIAN_IDL.events?.find((e) => e.name === name);
  if (event === undefined) throw new Error(`no event ${name}`);
  const body = coder.types.encode(name, data);
  const payload = Buffer.concat([Buffer.from(event.discriminator), body]).toString("base64");
  return [
    `Program ${programId} invoke [1]`,
    `Program data: ${payload}`,
    `Program ${programId} success`,
  ];
}

const settled = (market: PublicKey, outcome: "yes" | "no") =>
  logsWith("MarketSettled", {
    market,
    outcome: outcome === "yes" ? { Yes: {} } : { No: {} }, // the encoder takes PascalCase variants
    price: new BN(70_000).mul(new BN(10).pow(new BN(16))),
    source: { Oracle: {} },
    oracleSlot: new BN(7),
  });
const redeemed = (market: PublicKey, user: PublicKey) =>
  logsWith("Redeemed", {
    market,
    user,
    yesQty: new BN(5),
    noQty: new BN(0),
    usdc: new BN(5_000_000),
  });

function fakeRpc(
  bySignature: Record<string, string[] | null>,
  list: Record<string, SignatureInfo[]>,
): EvidenceRpc & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    signatures: (address) => Promise.resolve(list[address.toBase58()] ?? []),
    logs: (signature) => {
      reads.push(signature);
      return Promise.resolve(bySignature[signature] ?? null);
    },
  };
}

describe("decodeLogs", () => {
  it("decodes a program event from real log lines and survives garbage", () => {
    const market = Keypair.generate().publicKey;
    const events = decodeLogs(programId, settled(market, "yes"));
    expect(events.map((e) => e.name)).toEqual(["MarketSettled"]);
    expect(decodeLogs(programId, ["Program data: !!!not base64!!!", "noise"])).toEqual([]);
  });
});

describe("findSettlement", () => {
  const market = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;

  it("finds the MarketSettled transaction among newer redeem/settle_funds transactions", async () => {
    const rpc = fakeRpc(
      {
        newer: ["Program log: settle_funds"],
        settle: settled(market, "no"),
      },
      {
        [market.toBase58()]: [
          { signature: "newer", blockTime: 1_791_000_900, err: null },
          { signature: "settle", blockTime: 1_791_000_305, err: null },
        ],
      },
    );
    expect(await findSettlement(rpc, programId, market)).toEqual({
      signature: "settle",
      blockTime: 1_791_000_305,
      outcome: "NO",
    });
  });

  it("skips failed transactions and another market's settle event", async () => {
    const rpc = fakeRpc(
      { failed: settled(market, "yes"), foreign: settled(other, "yes") },
      {
        [market.toBase58()]: [
          { signature: "failed", blockTime: 1, err: { InstructionError: [0, "Custom"] } },
          { signature: "foreign", blockTime: 2, err: null },
        ],
      },
    );
    expect(await findSettlement(rpc, programId, market)).toBeNull();
    expect(rpc.reads).toEqual(["foreign"]); // the failed transaction is never even read
  });

  it("returns null for an unsettled market and tolerates unreadable transactions", async () => {
    const rpc = fakeRpc(
      {},
      { [market.toBase58()]: [{ signature: "gone", blockTime: null, err: null }] },
    );
    expect(await findSettlement(rpc, programId, market)).toBeNull();
    expect(await findSettlement(fakeRpc({}, {}), programId, market)).toBeNull();
  });

  it("keeps a null block time as unknown rather than inventing one", async () => {
    const rpc = fakeRpc(
      { s: settled(market, "yes") },
      { [market.toBase58()]: [{ signature: "s", blockTime: undefined, err: null }] },
    );
    expect((await findSettlement(rpc, programId, market))?.blockTime).toBeNull();
  });
});

describe("findRedeems", () => {
  const wallet = Keypair.generate().publicKey;
  const stranger = Keypair.generate().publicKey;
  const market = Keypair.generate().publicKey;
  const elsewhere = Keypair.generate().publicKey;

  it("returns only this wallet's successful redeems of the day's markets", async () => {
    const rpc = fakeRpc(
      {
        mine: redeemed(market, wallet),
        wrongMarket: redeemed(elsewhere, wallet),
        theirs: redeemed(market, stranger),
        failed: redeemed(market, wallet),
      },
      {
        [wallet.toBase58()]: [
          { signature: "mine", blockTime: 1, err: null },
          { signature: "wrongMarket", blockTime: 2, err: null },
          { signature: "theirs", blockTime: 3, err: null },
          { signature: "failed", blockTime: 4, err: "x" },
        ],
      },
    );
    expect(await findRedeems(rpc, programId, wallet, new Set([market.toBase58()]))).toEqual([
      { signature: "mine", market: market.toBase58() },
    ]);
  });
});
