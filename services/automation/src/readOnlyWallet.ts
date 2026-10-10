/**
 * A wallet that can never sign (AB-19). Chain reads that go through an Anchor program (the
 * open-time index reads Config) need a provider, and Anchor's provider needs a wallet: this one
 * has the default public key and rejects every signing call, so nothing built on it can be sent.
 */
import { type AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export type ProviderWallet = ConstructorParameters<typeof AnchorProvider>[1];

export const READ_ONLY_ERROR = "read-only";

export function readOnlyWallet(): ProviderWallet {
  return {
    publicKey: PublicKey.default,
    signTransaction: () => Promise.reject(new Error(READ_ONLY_ERROR)),
    signAllTransactions: () => Promise.reject(new Error(READ_ONLY_ERROR)),
  };
}
