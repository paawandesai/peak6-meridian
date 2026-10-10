// @vitest-environment node
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { type Intent, marketAddresses, MERIDIAN_IDL, MERIDIAN_PROGRAM_ID } from "@meridian/client";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { BOOK, fillLog, key, programLogs, USER } from "./test-support";
import {
  createTradeActions,
  type SigningWallet,
  targetFor,
  type TradeConnection,
  type TradeRequest,
} from "./tx";
import type { PublicConfig } from "@/lib/config";
import type { MarketRow } from "@/lib/markets";
import { market as marketRow } from "@/test-utils";
import { createMeridianProgram } from "@meridian/client";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";

const coder = new BorshInstructionCoder(MERIDIAN_IDL);
const USDC = key(5);
const addresses = marketAddresses({ symbol: "NVDA", tradingDate: 20261008, strikeCents: 18_000n });
const row: MarketRow = marketRow({
  address: addresses.market.toBase58(),
  ticker: "NVDA",
  tradingDate: 20261008,
  strikeCents: 18_000n,
});
const config: PublicConfig = {
  cluster: "localnet",
  rpcUrl: "http://127.0.0.1:8899",
  programId: MERIDIAN_PROGRAM_ID,
  usdcMint: USDC,
};

/** Names of the program instructions in a compiled transaction; the ATA ones are named too. */
function names(tx: VersionedTransaction): string[] {
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions.map((ix) => {
    const program = keys[ix.programIdIndex] as PublicKey;
    if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return "create_ata_idempotent";
    if (!program.equals(MERIDIAN_PROGRAM_ID)) return program.toBase58();
    return coder.decode(Buffer.from(ix.data))?.name ?? "unknown";
  });
}

function harness(
  overrides: { simulate?: unknown; confirm?: unknown; sign?: () => Promise<never> } = {},
) {
  const user = Keypair.generate();
  const signed: VersionedTransaction[] = [];
  const connection = {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: vi
      .fn()
      .mockResolvedValue(
        overrides.simulate ?? { context: { slot: 1 }, value: { err: null, logs: [] } },
      ),
    sendRawTransaction: vi.fn().mockResolvedValue("SigSent"),
    confirmTransaction: vi
      .fn()
      .mockResolvedValue(overrides.confirm ?? { context: { slot: 1 }, value: { err: null } }),
    getSignatureStatuses: vi
      .fn()
      .mockResolvedValue({ context: { slot: 1 }, value: [{ slot: 777 }] }),
  };
  const wallet = {
    publicKey: user.publicKey,
    signTransaction: vi.fn(async <T extends VersionedTransaction>(tx: T): Promise<T> => {
      if (overrides.sign) return overrides.sign();
      signed.push(tx);
      return tx;
    }),
  };
  const actions = createTradeActions(
    connection as unknown as TradeConnection,
    wallet as unknown as SigningWallet,
    config,
    row,
  );
  return { actions, connection, wallet, signed, user };
}

const request = (intent: Intent, kind: "limit" | "ioc" = "ioc"): TradeRequest => ({
  intent,
  kind,
  priceCents: intent === "BUY_YES" || intent === "BUY_NO" ? 99 : 1,
  qty: 5n,
  book: BOOK,
});

describe("one transaction, one signature per intent (AC1)", () => {
  const cases: [Intent, string, boolean][] = [
    ["BUY_YES", "place_order", false],
    ["SELL_YES", "place_order", false],
    ["BUY_NO", "buy_no", true],
    ["SELL_NO", "sell_no", true],
  ];

  it.each(cases)(
    "%s → %s: a single transaction and a single wallet signature",
    async (intent, instruction, withNo) => {
      const { actions, connection, wallet, signed } = harness();
      const phases: string[] = [];
      const result = await actions.trade(request(intent), (phase) => phases.push(phase));
      expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ signature: "SigSent", slot: 777 });
      expect(phases).toEqual(["awaiting-signature", "confirming"]);
      const [tx] = signed;
      expect(tx).toBeDefined();
      // Account setup, the one trade instruction, then the automatic settle_funds (and nothing else).
      expect(names(tx as VersionedTransaction)).toEqual([
        ...Array<string>(withNo ? 3 : 2).fill("create_ata_idempotent"),
        instruction,
        "settle_funds",
      ]);
    },
  );

  it("simulating never asks the wallet to sign", async () => {
    const { actions, wallet, connection } = harness();
    await actions.simulate(request("BUY_YES"));
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(connection.simulateTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("simulate", () => {
  it("returns the Fill events of the simulation's logs", async () => {
    const { actions, user } = harness({
      simulate: {
        context: { slot: 1 },
        value: { err: null, logs: programLogs([fillLog(61, 5, USER)]) },
      },
    });
    void user;
    const outcome = await actions.simulate(request("BUY_YES"));
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) expect(outcome.events).toMatchObject([{ kind: "Fill", price: 61, qty: 5n }]);
  });

  it("returns the program's reason when the simulation fails", async () => {
    const { actions } = harness({
      simulate: {
        context: { slot: 1 },
        value: { err: { InstructionError: [2, { Custom: 6016 }] }, logs: [] },
      },
    });
    expect(await actions.simulate(request("BUY_YES"))).toEqual({
      ok: false,
      reason: "Trading is paused: no minting or new orders",
    });
  });
});

describe("failure paths", () => {
  it("a wallet that declines sends nothing", async () => {
    const { actions, connection } = harness({
      sign: () => Promise.reject(new Error("User rejected the request")),
    });
    await expect(actions.trade(request("BUY_YES"))).rejects.toThrow("User rejected the request");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a transaction that fails to confirm reports the program's reason", async () => {
    const { actions } = harness({
      confirm: {
        context: { slot: 1 },
        value: { err: { InstructionError: [2, { Custom: 6015 }] } },
      },
    });
    await expect(actions.trade(request("BUY_YES"))).rejects.toThrow(/Market is closed/);
  });

  it("refuses a market address that does not match its ticker, date and strike", () => {
    const program = createMeridianProgram(
      new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}),
    );
    expect(() => targetFor({ ...row, address: key(3).toBase58() }, program, USER, USDC)).toThrow(
      /does not match/,
    );
  });
});

describe("recovery actions: one transaction, one signature each", () => {
  it("cancel returns the escrow in the same transaction", async () => {
    const { actions, wallet, signed } = harness();
    await actions.cancel(7n);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(names(signed[0] as VersionedTransaction)).toEqual([
      "create_ata_idempotent",
      "create_ata_idempotent",
      "cancel_order",
      "settle_funds",
    ]);
  });

  it("withdraw is settle_funds", async () => {
    const { actions, signed } = harness();
    await actions.withdraw();
    expect(names(signed[0] as VersionedTransaction).slice(-1)).toEqual(["settle_funds"]);
  });

  it("pair and winner redeem are one redeem instruction with the quantities given", async () => {
    const pair = harness();
    await pair.actions.redeemPair(4n);
    expect(names(pair.signed[0] as VersionedTransaction).slice(-1)).toEqual(["redeem"]);
    const data = (pair.signed[0] as VersionedTransaction).message.compiledInstructions.at(-1)?.data;
    const decoded = coder.decode(Buffer.from(data as Uint8Array)) as unknown as {
      data: { yes_qty: { toString(): string }; no_qty: { toString(): string } };
    };
    expect(decoded.data.yes_qty.toString()).toBe("4");
    expect(decoded.data.no_qty.toString()).toBe("4");

    const winner = harness();
    await winner.actions.redeemWinner(10n, 3n);
    const wdata = (winner.signed[0] as VersionedTransaction).message.compiledInstructions.at(
      -1,
    )?.data;
    const wdec = coder.decode(Buffer.from(wdata as Uint8Array)) as unknown as {
      data: { yes_qty: { toString(): string }; no_qty: { toString(): string } };
    };
    expect([wdec.data.yes_qty.toString(), wdec.data.no_qty.toString()]).toEqual(["10", "3"]);
  });
});
