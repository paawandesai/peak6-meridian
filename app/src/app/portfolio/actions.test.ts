// @vitest-environment node
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { MERIDIAN_IDL } from "@meridian/client";
import { Keypair, type Transaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { createActions } from "./actions";
import { AAPL, MSFT, NVDA } from "./fixtures";
import { parsePublicConfig } from "@/lib/config";

const user = Keypair.generate();
const coder = new BorshInstructionCoder(MERIDIAN_IDL);
const program = { programId: parsePublicConfig({}).programId };
const usdcMint = Keypair.generate().publicKey;
const config = parsePublicConfig({ usdcMint: usdcMint.toBase58() });

function harness(err: unknown = null) {
  const signAllTransactions = vi.fn((txs: Transaction[]) => {
    txs.forEach((tx) => tx.partialSign(user));
    return Promise.resolve(txs);
  });
  const sendRawTransaction = vi.fn().mockResolvedValue("sig");
  const connection = {
    getLatestBlockhash: () =>
      Promise.resolve({
        blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
        lastValidBlockHeight: 10,
      }),
    sendRawTransaction,
    confirmTransaction: () => Promise.resolve({ context: { slot: 77 }, value: { err } }),
  };
  const actions = createActions(config, connection as never, {
    publicKey: user.publicKey,
    signAllTransactions,
  });
  return { actions, signAllTransactions, sendRawTransaction };
}

const slice = (amount: bigint) => ({ account: Keypair.generate().publicKey.toBase58(), amount });
const item = (
  market: typeof AAPL,
  yes: bigint[],
  no: bigint[] = [],
  usdc: string | null = null,
) => ({
  market,
  yesAccounts: yes.map(slice),
  noAccounts: no.map(slice),
  usdcAccount: usdc,
});

describe("createActions", () => {
  it("one redeem is one transaction and one wallet approval", async () => {
    const { actions, signAllTransactions, sendRawTransaction } = harness();
    const result = await actions.redeem([item(AAPL, [40n])]);
    expect(result).toEqual({ signature: "sig", slot: 77 });
    expect(signAllTransactions).toHaveBeenCalledTimes(1);
    expect(signAllTransactions.mock.calls[0]?.[0]).toHaveLength(1);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("Redeem all over many markets is chunked but still ONE wallet approval", async () => {
    const { actions, signAllTransactions, sendRawTransaction } = harness();
    const items = [AAPL, MSFT, AAPL, MSFT, AAPL].map((market) => item(market, [1n]));
    await actions.redeem(items);
    expect(signAllTransactions).toHaveBeenCalledTimes(1);
    expect(signAllTransactions.mock.calls[0]?.[0]).toHaveLength(2);
    expect(sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it("a wallet with its YES split over two token accounts redeems each account's own amount, paying the passed USDC account", async () => {
    const { actions, signAllTransactions } = harness();
    const usdc = Keypair.generate().publicKey.toBase58();
    const yes = [slice(6n), slice(4n)];
    await actions.redeem([{ ...item(AAPL, [], [], usdc), yesAccounts: yes }]);
    const transaction = signAllTransactions.mock.calls[0]?.[0][0];
    const redeems = (transaction?.instructions ?? []).filter((instruction) =>
      instruction.programId.equals(program.programId),
    );
    // One redeem per account pair: 6 from the first account, 4 from the second, never 10 from one.
    const amounts = redeems.map((instruction) => {
      const decoded = coder.decode(instruction.data);
      const data = decoded?.data as { yes_qty: { toString(): string } };
      return [data.yes_qty.toString(), instruction.keys[3]?.pubkey.toBase58()];
    });
    expect(amounts).toEqual([
      ["6", yes[0]?.account],
      ["4", yes[1]?.account],
    ]);
    expect(redeems.every((instruction) => instruction.keys[2]?.pubkey.toBase58() === usdc)).toBe(
      true,
    );
  });

  it("withdraw builds settle_funds for each market", async () => {
    const { actions, signAllTransactions } = harness();
    await actions.withdraw([NVDA]);
    expect(signAllTransactions).toHaveBeenCalledTimes(1);
  });

  it("surfaces an on-chain failure", async () => {
    const { actions } = harness({ InstructionError: [0, "Custom"] });
    await expect(actions.redeem([item(AAPL, [1n])])).rejects.toThrow(/failed on chain/);
  });

  it("needs a configured USDC mint", async () => {
    const noMint = createActions(parsePublicConfig({}), {} as never, {
      publicKey: user.publicKey,
      signAllTransactions: () => Promise.reject(new Error("unused")),
    });
    await expect(noMint.withdraw([NVDA])).rejects.toThrow(/USDC_MINT/);
    await expect(noMint.redeem([item(AAPL, [1n])])).rejects.toThrow(/USDC_MINT/);
  });
});
