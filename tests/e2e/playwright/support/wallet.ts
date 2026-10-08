/**
 * An injected test wallet (Wallet Standard), so the app's real wallet-adapter code path runs with
 * no browser extension. The page-side wallet only forwards `signTransaction` to Node, where the
 * throwaway keypair signs and every request is counted: AC2 asserts exactly one per trade.
 *
 * Only `signTransaction` is offered (not `signAndSendTransaction`), so the adapter signs once and
 * sends the raw transaction itself; one request is one wallet prompt.
 */
import type { Page } from "@playwright/test";
import { type Keypair, VersionedTransaction } from "@solana/web3.js";

export const WALLET_NAME = "E2E Test Wallet";

export type TestWallet = {
  readonly keypair: Keypair;
  /** Number of signature requests the page has made since the last `reset()`. */
  requests(): number;
  reset(): void;
};

/** Runs inside the page, before any app script: registers the wallet with the Wallet Standard. */
function pageWallet(init: { name: string; address: string; publicKey: number[] }): void {
  const w = globalThis as unknown as {
    __e2eSign: (tx: number[]) => Promise<number[]>;
    dispatchEvent: (e: Event) => boolean;
    addEventListener: (type: string, l: (e: Event) => void) => void;
  };
  const publicKey = Uint8Array.from(init.publicKey);
  const chains = ["solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet"] as const;
  const account = {
    address: init.address,
    publicKey,
    chains,
    features: ["solana:signTransaction"],
  };
  type Listener = (props: { accounts?: unknown[] }) => void;
  const listeners = new Set<Listener>();
  let accounts: unknown[] = [];
  const wallet = {
    version: "1.0.0",
    name: init.name,
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiBmaWxsPSIjMDAwIi8+PC9zdmc+",
    chains,
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: () => {
          accounts = [account];
          listeners.forEach((l) => l({ accounts }));
          return Promise.resolve({ accounts });
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: () => {
          accounts = [];
          listeners.forEach((l) => l({ accounts }));
          return Promise.resolve();
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event: string, listener: Listener) => {
          if (event === "change") listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          const outputs: { signedTransaction: Uint8Array }[] = [];
          for (const input of inputs) {
            const signed = await w.__e2eSign(Array.from(input.transaction));
            outputs.push({ signedTransaction: Uint8Array.from(signed) });
          }
          return outputs;
        },
      },
    },
  };
  const callback = (api: { register: (...wallets: unknown[]) => unknown }): void => {
    api.register(wallet);
  };
  w.addEventListener("wallet-standard:app-ready", (event) => {
    callback((event as CustomEvent<{ register: (...wallets: unknown[]) => unknown }>).detail);
  });
  w.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
}

/** Injects the wallet into every page of `page`'s context and counts its signature requests. */
export async function installTestWallet(page: Page, keypair: Keypair): Promise<TestWallet> {
  let count = 0;
  await page.exposeFunction("__e2eSign", (bytes: number[]): number[] => {
    count += 1;
    const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes));
    tx.sign([keypair]);
    return Array.from(tx.serialize());
  });
  await page.addInitScript(pageWallet, {
    name: WALLET_NAME,
    address: keypair.publicKey.toBase58(),
    publicKey: Array.from(keypair.publicKey.toBytes()),
  });
  return {
    keypair,
    requests: () => count,
    reset: () => {
      count = 0;
    },
  };
}

/** Connect through the app's wallet button and modal, as a user would. */
export async function connectWallet(page: Page, address: string): Promise<void> {
  await page
    .getByRole("button", { name: /select wallet|connect wallet/i })
    .first()
    .click();
  await page.getByRole("button", { name: new RegExp(WALLET_NAME) }).click();
  await page
    .getByRole("button", { name: new RegExp(`^${address.slice(0, 4)}`) })
    .first()
    .waitFor();
}
