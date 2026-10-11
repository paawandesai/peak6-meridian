/**
 * Demo wallet: devnet-only Wallet Standard wallet (M4-07, D-055).
 * Auto-funded through /api/faucet, auto-signs without popups.
 * Uses sharedConnection for one Connection app-wide (P0-4).
 */
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { feeSolNotice } from "./funding";
import { load, reset, save } from "./storage";
import { sharedConnection } from "@/lib/rpc";

let rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || "";

/** Set the RPC URL for the demo wallet (called by providers.tsx). */
export function setDemoWalletRpcUrl(url: string): void {
  rpcUrl = url;
}

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
    version: string;
    supportedTransactionVersions: readonly (string | number)[];
    signTransaction(
      ...inputs: { transaction: Uint8Array; account?: WalletAccount; chain?: string }[]
    ): Promise<{ signedTransaction: Uint8Array }[]>;
  };
  "solana:signAndSendTransaction": {
    version: string;
    supportedTransactionVersions: readonly (string | number)[];
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
  #signatureCount = 0;
  #hasFunded = false;

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
        return { accounts: [...this.#accounts] };
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
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs) => {
        this.#signatureCount += inputs.length;
        return inputs.map(({ transaction }) => {
          const tx = VersionedTransaction.deserialize(transaction);
          tx.sign([this.#keypair]);
          return { signedTransaction: tx.serialize() };
        });
      },
    },
    "solana:signAndSendTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signAndSendTransaction: async (...inputs) => {
        this.#signatureCount += inputs.length;
        const connection = this.#getConnection();
        const results: { signature: Uint8Array }[] = [];
        for (const { transaction } of inputs) {
          const tx = VersionedTransaction.deserialize(transaction);
          tx.sign([this.#keypair]);
          const sig = await connection.sendRawTransaction(tx.serialize());
          results.push({ signature: bs58.decode(sig) });
        }
        return results;
      },
    },
    "solana:signMessage": {
      signMessage: async (...inputs) => {
        return inputs.map(({ message }) => {
          const signature = nacl.sign.detached(message, this.#keypair.secretKey);
          return { signedMessage: message, signature };
        });
      },
    },
  };

  async #autoFund(): Promise<void> {
    // Auto-fund on first connect only. After reload, autoConnect triggers connect() again but
    // the wallet is already funded, so skip the faucet (and avoid alerting on 429).
    if (this.#hasFunded) return;

    const connection = this.#getConnection();
    const pubkey = this.#keypair.publicKey;

    // Check if already funded: need fee SOL + USDC mint from config
    try {
      const solBalance = await connection.getBalance(pubkey);
      const hasSol = solBalance > 0;
      // The USDC check requires the mint from config; if unavailable, proceed with faucet.
      // A funded wallet should have both, so checking SOL alone is a reasonable heuristic.
      if (hasSol) {
        this.#hasFunded = true;
        return;
      }
    } catch {
      // Balance check failed; proceed to faucet
    }

    const wallet = pubkey.toBase58();
    try {
      const response = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      if (response.ok) {
        // The faucet minted test-USDC and, for this fresh wallet, sent fee SOL in the same
        // transaction; say so when it could not spare the SOL (the wallet cannot trade without it).
        this.#hasFunded = true;
        const notice = feeSolNotice(await response.json().catch(() => null));
        if (notice !== null) alert(notice);
        return;
      } else if (response.status === 429) {
        // 24h limit hit. If the wallet already has SOL (checked above), this is a benign retry
        // after reload; otherwise it's a real exhaustion and worth alerting.
        const solBalance = await connection.getBalance(pubkey).catch(() => 0);
        if (solBalance === 0) {
          alert(
            "Demo wallet: You've already claimed test funds recently. " +
              "The faucet allows one claim per wallet per 24 hours.",
          );
        }
      } else if (response.status === 503) {
        alert(
          "Demo wallet: The faucet is temporarily out of funds. " +
            "Please try again later or use a different wallet.",
        );
      } else {
        console.warn(`Demo wallet: faucet returned ${response.status}`);
      }
    } catch (error) {
      console.warn("Demo wallet: faucet call failed", error);
    }
  }

  #getConnection() {
    return sharedConnection(rpcUrl);
  }

  /** For e2e testing: count of signature requests since wallet creation. Reset with resetDemoWallet(). */
  get signatureCount(): number {
    return this.#signatureCount;
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
  // AC6: The demo wallet is devnet-only for security. Only register when the cluster is devnet.
  const cluster = process.env.NEXT_PUBLIC_CLUSTER;
  if (cluster !== "devnet") return;

  const wallet = createOrLoadDemoWallet() as DemoWallet;
  const w = window as unknown as {
    dispatchEvent: (e: Event) => void;
    addEventListener: (type: string, listener: (e: Event) => void) => void;
    __demoWallet?: DemoWallet;
  };
  const callback = (api: { register: (wallet: Wallet) => void }) => api.register(wallet);

  // Expose for e2e testing (signature count verification)
  w.__demoWallet = wallet;

  // Listen for app-ready in case the app loads after registration
  w.addEventListener("wallet-standard:app-ready", (event) => {
    callback((event as CustomEvent<{ register: (wallet: Wallet) => void }>).detail);
  });

  // Dispatch registration in case the app is already ready
  w.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
}
