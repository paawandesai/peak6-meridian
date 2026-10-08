// @vitest-environment node
import { Keypair, type Transaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { createActions } from "./actions";
import { AAPL, MSFT, NVDA } from "./fixtures";
import { parsePublicConfig } from "@/lib/config";

const user = Keypair.generate();
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

describe("createActions", () => {
  it("one redeem is one transaction and one wallet approval", async () => {
    const { actions, signAllTransactions, sendRawTransaction } = harness();
    const result = await actions.redeem([{ market: AAPL, yesQty: 40n, noQty: 0n }]);
    expect(result).toEqual({ signature: "sig", slot: 77 });
    expect(signAllTransactions).toHaveBeenCalledTimes(1);
    expect(signAllTransactions.mock.calls[0]?.[0]).toHaveLength(1);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("Redeem all over many markets is chunked but still ONE wallet approval", async () => {
    const { actions, signAllTransactions, sendRawTransaction } = harness();
    const items = [AAPL, MSFT, AAPL, MSFT, AAPL].map((market) => ({
      market,
      yesQty: 1n,
      noQty: 0n,
    }));
    await actions.redeem(items);
    expect(signAllTransactions).toHaveBeenCalledTimes(1);
    expect(signAllTransactions.mock.calls[0]?.[0]).toHaveLength(2);
    expect(sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it("withdraw builds settle_funds for each market", async () => {
    const { actions, signAllTransactions } = harness();
    await actions.withdraw([NVDA]);
    expect(signAllTransactions).toHaveBeenCalledTimes(1);
  });

  it("surfaces an on-chain failure", async () => {
    const { actions } = harness({ InstructionError: [0, "Custom"] });
    await expect(actions.redeem([{ market: AAPL, yesQty: 1n, noQty: 0n }])).rejects.toThrow(
      /failed on chain/,
    );
  });

  it("needs a configured USDC mint", async () => {
    const noMint = createActions(parsePublicConfig({}), {} as never, {
      publicKey: user.publicKey,
      signAllTransactions: () => Promise.reject(new Error("unused")),
    });
    await expect(noMint.withdraw([NVDA])).rejects.toThrow(/USDC_MINT/);
    await expect(noMint.redeem([{ market: AAPL, yesQty: 1n, noQty: 0n }])).rejects.toThrow(
      /USDC_MINT/,
    );
  });
});
