// @vitest-environment node
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { createAdminActions, explorerTxUrl } from "./admin-chain";
import { parsePublicConfig } from "./config";

describe("explorerTxUrl", () => {
  it("links devnet directly and other clusters through a custom URL", () => {
    expect(
      explorerTxUrl("SIG", parsePublicConfig({ cluster: "devnet", rpcUrl: "https://rpc.test" })),
    ).toBe("https://explorer.solana.com/tx/SIG?cluster=devnet");
    expect(explorerTxUrl("SIG", parsePublicConfig({}))).toBe(
      "https://explorer.solana.com/tx/SIG?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899",
    );
  });
});

describe("createAdminActions", () => {
  it("asks the connected wallet to sign the pause transaction and nothing else", async () => {
    const admin = Keypair.generate();
    const signed: number[] = [];
    const connection = {
      rpcEndpoint: "http://127.0.0.1:8899",
      commitment: "confirmed",
      getLatestBlockhash: () =>
        Promise.resolve({ blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 }),
      sendRawTransaction: () => Promise.reject(new Error("stop after signing")),
      getSignatureStatuses: () => Promise.resolve({ value: [] }),
    };
    const actions = createAdminActions(
      connection as never,
      {
        publicKey: admin.publicKey,
        signTransaction: (tx) => {
          signed.push(1);
          return Promise.resolve(tx);
        },
        signAllTransactions: (txs) => Promise.resolve(txs),
      },
      parsePublicConfig({ programId: "3RovidBTwYzUfhniunxsUgnLzsbWz6qt3PGpvD23HDZq" }),
    );
    await expect(actions.setPaused(true)).rejects.toThrow();
    expect(signed).toHaveLength(1);
  });
});
