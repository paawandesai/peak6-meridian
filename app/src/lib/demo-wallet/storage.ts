/**
 * Demo wallet localStorage persistence (M4-07, D-055).
 *
 * The keypair secret is stored in the browser only, never logged or sent anywhere.
 * Devnet only: this key has no value and is clearly labeled as demo/test.
 */
import { Keypair } from "@solana/web3.js";

const STORAGE_KEY = "meridian.demoWallet.v1";

export type StoredWallet = {
  secretKey: number[]; // Uint8Array as JSON-serializable array
  created: number; // timestamp ms
};

export function load(): Keypair | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored: StoredWallet = JSON.parse(raw);
    return Keypair.fromSecretKey(Uint8Array.from(stored.secretKey));
  } catch {
    return null;
  }
}

export function save(keypair: Keypair): void {
  if (typeof window === "undefined") return;
  const stored: StoredWallet = {
    secretKey: Array.from(keypair.secretKey),
    created: Date.now(),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

export function reset(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
