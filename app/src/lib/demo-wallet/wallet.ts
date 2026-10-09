/**
 * Demo wallet: devnet-only Wallet Standard wallet (M4-07, D-055).
 * Auto-funded through /api/faucet, auto-signs without popups.
 */
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { load, reset, save } from "./storage";

type Wallet = {
  version: string;
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly WalletAccount[];
  features: Record<string, unknown>;
};

type WalletAccount = {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
};

export const DEMO_WALLET_NAME = "Try the demo";
const DEVNET_CHAIN = "solana:devnet";

type DemoWalletFeatures = {
  "standard:connect": { connect(): Promise<{ accounts: WalletAccount[] }> };
  "standard:disconnect": { disconnect(): Promise<void> };
  "standard:events": {
    on(event: string, listener: (props: { accounts?: WalletAccount[] }) => void): () => void;
  };
  "solana:signTransaction": {
    signTransaction(
      ...inputs: { transaction: Uint8Array; account?: WalletAccount; chain?: string }[]
    ): Promise<{ signedTransaction: Uint8Array }[]>;
  };
  "solana:signAndSendTransaction": {
    signAndSendTransaction(
      ...inputs: { transaction: Uint8Array; account?: WalletAccount; chain?: string }[]
    ): Promise<{ signature: Uint8Array }[]>;
  };
  "solana:signMessage": {
    signMessage(
      ...inputs: { message: Uint8Array; account?: WalletAccount }[]
    ): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]>;
  };
};

export class DemoWallet implements Wallet {
  readonly #keypair: Keypair;
  readonly #listeners = new Set<(props: { accounts?: WalletAccount[] }) => void>();
  #accounts: WalletAccount[] = [];
  #connection: Connection | null = null;

  constructor(keypair: Keypair) {
    this.#keypair = keypair;
  }

  readonly version = "1.0.0" as const;
  readonly name = DEMO_WALLET_NAME;
  readonly icon =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiBmaWxsPSIjZmY2NjAwIi8+PC9zdmc+" as const;
  readonly chains = [DEVNET_CHAIN] as const;

  get accounts(): readonly WalletAccount[] {
    return this.#accounts;
  }

  readonly features: DemoWalletFeatures = {
    "standard:connect": {
      connect: async () => {
        const account: WalletAccount = {
          address: this.#keypair.publicKey.toBase58(),
          publicKey: this.#keypair.publicKey.toBytes(),
          chains: [DEVNET_CHAIN],
          features: [
            "solana:signTransaction",
            "solana:signAndSendTransaction",
            "solana:signMessage",
          ],
        };
        this.#accounts = [account];
        this.#listeners.forEach((l) => l({ accounts: this.#accounts }));
        await this.#autoFund();
        return { accounts: this.#accounts };
      },
    },
    "standard:disconnect": {
      disconnect: async () => {
        this.#accounts = [];
        this.#listeners.forEach((l) => l({ accounts: this.#accounts }));
      },
    },
    "standard:events": {
      on: (event, listener) => {
        if (event === "change") this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    },
    "solana:signTransaction": {
      signTransaction: async (...inputs) => {
        return inputs.map(({ transaction }) => {
          const tx = VersionedTransaction.deserialize(transaction);
          tx.sign([this.#keypair]);
          return { signedTransaction: tx.serialize() };
        });
      },
    },
    "solana:signAndSendTransaction": {
      signAndSendTransaction: async (...inputs) => {
        const connection = this.#getConnection();
        const results: { signature: Uint8Array }[] = [];
        for (const { transaction } of inputs) {
          const tx = VersionedTransaction.deserialize(transaction);
          tx.sign([this.#keypair]);
          const sig = await connection.sendRawTransaction(tx.serialize());
          results.push({ signature: Buffer.from(sig, "utf8") });
        }
        return results;
      },
    },
    "solana:signMessage": {
      signMessage: async (...inputs) => {
        return inputs.map(({ message }) => {
          const signature = new Uint8Array(64);
          return { signedMessage: message, signature };
        });
      },
    },
  };

  async #autoFund(): Promise<void> {
    try {
      const response = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: this.#keypair.publicKey.toBase58() }),
      });
      if (!response.ok && response.status !== 429) {
        console.warn(`Demo wallet: faucet returned ${response.status}`);
      }
    } catch (error) {
      console.warn("Demo wallet: faucet call failed", error);
    }
  }

  #getConnection(): Connection {
    if (!this.#connection) {
      this.#connection = new Connection(
        process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com",
      );
    }
    return this.#connection;
  }
}

export function createOrLoadDemoWallet(): Wallet {
  let keypair = load();
  if (!keypair) {
    keypair = Keypair.generate();
    save(keypair);
  }
  return new DemoWallet(keypair);
}

export function resetDemoWallet(): void {
  reset();
}

export function registerDemoWallet(): void {
  if (typeof window === "undefined") return;
  if (process.env.NEXT_PUBLIC_CLUSTER !== "devnet") return;

  const wallet = createOrLoadDemoWallet();
  const w = window as unknown as { dispatchEvent: (e: Event) => void };
  const callback = (api: { register: (wallet: Wallet) => void }) => api.register(wallet);
  w.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
}
