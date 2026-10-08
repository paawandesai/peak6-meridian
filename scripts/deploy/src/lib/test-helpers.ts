import { Keypair } from "@solana/web3.js";

import { TICKER_ORDER } from "./feeds-file";

/** A syntactically valid feeds file: distinct pubkeys, hash = ticker/source index repeated. */
export function feedsJson(): Record<string, { pubkey: string; hash: string }[]> {
  const out: Record<string, { pubkey: string; hash: string }[]> = {};
  TICKER_ORDER.forEach((ticker, t) => {
    out[ticker] = [0, 1].map((s) => ({
      pubkey: Keypair.generate().publicKey.toBase58(),
      hash: (t * 2 + s).toString(16).padStart(2, "0").repeat(32),
    }));
  });
  return out;
}
