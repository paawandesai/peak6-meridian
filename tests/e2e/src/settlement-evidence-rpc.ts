/**
 * Finds Friday's evidence on chain (M3-09 AC2): for a market, the transaction whose logs carry its
 * `MarketSettled` event, and for a wallet, the `Redeemed` events of the day's markets. The RPC is
 * injected, so tests run on recorded logs; events are decoded with the generated client's IDL.
 */
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import { MERIDIAN_IDL } from "@meridian/client";
import type { PublicKey } from "@solana/web3.js";

export type SignatureInfo = {
  readonly signature: string;
  readonly blockTime: number | null | undefined;
  /** Non-null for a failed transaction. */
  readonly err: unknown;
};

export type EvidenceRpc = {
  /** Signatures touching `address`, newest first. */
  signatures(address: PublicKey, limit: number): Promise<readonly SignatureInfo[]>;
  /** The log messages of a transaction, or `null` when it cannot be read. */
  logs(signature: string): Promise<readonly string[] | null>;
};

export type DecodedEvent = { readonly name: string; readonly data: Record<string, unknown> };

export function decodeLogs(programId: PublicKey, logs: readonly string[]): DecodedEvent[] {
  const parser = new EventParser(programId, new BorshCoder(MERIDIAN_IDL));
  try {
    return [...parser.parseLogs([...logs])].map((event) => ({
      name: event.name,
      data: event.data as Record<string, unknown>,
    }));
  } catch {
    return []; // a malformed log line must not break the report
  }
}

const keyOf = (value: unknown): string | null =>
  typeof value === "object" && value !== null && "toBase58" in value
    ? String((value as { toBase58(): string }).toBase58())
    : null;

export type SettleFound = {
  readonly signature: string;
  readonly blockTime: number | null;
  readonly outcome: "YES" | "NO";
};

/** The settle transaction of `market`, scanning at most `limit` of its newest signatures. */
export async function findSettlement(
  rpc: EvidenceRpc,
  programId: PublicKey,
  market: PublicKey,
  limit = 25,
): Promise<SettleFound | null> {
  for (const info of await rpc.signatures(market, limit)) {
    if (info.err !== null && info.err !== undefined) continue;
    const logs = await rpc.logs(info.signature);
    if (logs === null) continue;
    for (const event of decodeLogs(programId, logs)) {
      if (event.name !== "marketSettled" && event.name !== "MarketSettled") continue;
      if (keyOf(event.data.market) !== market.toBase58()) continue;
      const outcome = event.data.outcome;
      const yes = typeof outcome === "object" && outcome !== null && "yes" in outcome;
      return {
        signature: info.signature,
        blockTime: info.blockTime ?? null,
        outcome: yes ? "YES" : "NO",
      };
    }
  }
  return null;
}

export type RedeemFound = { readonly signature: string; readonly market: string };

/** `wallet`'s successful redeems of any of `markets`, among its newest `limit` signatures. */
export async function findRedeems(
  rpc: EvidenceRpc,
  programId: PublicKey,
  wallet: PublicKey,
  markets: ReadonlySet<string>,
  limit = 50,
): Promise<RedeemFound[]> {
  const found: RedeemFound[] = [];
  for (const info of await rpc.signatures(wallet, limit)) {
    if (info.err !== null && info.err !== undefined) continue;
    const logs = await rpc.logs(info.signature);
    if (logs === null) continue;
    for (const event of decodeLogs(programId, logs)) {
      if (event.name !== "redeemed" && event.name !== "Redeemed") continue;
      const market = keyOf(event.data.market);
      if (market !== null && markets.has(market) && keyOf(event.data.user) === wallet.toBase58()) {
        found.push({ signature: info.signature, market });
      }
    }
  }
  return found;
}
