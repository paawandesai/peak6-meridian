/**
 * `settlement-evidence` (M3-09 AC2): after the 16:05 ET settlement, reads each of the day's
 * markets for its `MarketSettled` transaction, the latency against the 10-minute budget and the
 * given wallets' redeems, and writes the explorer-linked entry for docs/log.md. Read-only.
 *
 *   pnpm --filter e2e run settlement-evidence -- [--date YYYYMMDD] [--wallet PUBKEY ...]
 *     [--capture PATH ...] [--out DIR] [--who NAME]
 *
 * Environment: SOLANA_CLUSTER, SOLANA_RPC_URL, optional MERIDIAN_PROGRAM_ID. Exit code 0 only when
 * every market settled within budget and a redeem is recorded.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PublicKey } from "@solana/web3.js";

import { connectReadOnly, etTradingDate, isoDate, marketsOfDate } from "./friday-chain";
import { findRedeems, findSettlement, type EvidenceRpc } from "./settlement-evidence-rpc";
import {
  type RedeemRow,
  renderEvidence,
  type SettlementRow,
  judge,
} from "./settlement-evidence-core";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      date: { type: "string" },
      wallet: { type: "string", multiple: true },
      capture: { type: "string", multiple: true },
      out: { type: "string" },
      who: { type: "string" },
    },
    strict: true,
  });
  const chain = await connectReadOnly(process.env);
  const date =
    values.date === undefined
      ? etTradingDate(Math.floor(Date.now() / 1000))
      : Number(/^\d{8}$/.test(values.date) ? values.date : Number.NaN);
  if (!Number.isInteger(date)) throw new Error("--date must be YYYYMMDD");
  const rpc: EvidenceRpc = {
    signatures: async (address, limit) =>
      (await chain.connection.getSignaturesForAddress(address, { limit }, "confirmed")).map(
        (info) => ({ signature: info.signature, blockTime: info.blockTime, err: info.err }),
      ),
    logs: async (signature) =>
      (
        await chain.connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
      )?.meta?.logMessages ?? null,
  };
  try {
    const markets = await marketsOfDate(chain.program, date);
    const rows: SettlementRow[] = [];
    for (const market of markets) {
      const found = await findSettlement(rpc, chain.programId, market.address);
      rows.push({
        label: market.label,
        market: market.address.toBase58(),
        closeTs: market.closeTs,
        settledAt: found?.blockTime ?? null,
        signature: found?.signature ?? null,
        outcome: found?.outcome ?? null,
      });
    }
    const labelOf = new Map(markets.map((m) => [m.address.toBase58(), m.label]));
    const redeems: RedeemRow[] = [];
    for (const wallet of values.wallet ?? []) {
      const key = new PublicKey(wallet);
      for (const found of await findRedeems(rpc, chain.programId, key, new Set(labelOf.keys()))) {
        redeems.push({
          label: labelOf.get(found.market) ?? found.market,
          signature: found.signature,
          wallet,
        });
      }
    }
    const evidence = { rows, redeems, cluster: chain.cluster };
    const entry = renderEvidence(evidence, {
      who: values.who ?? "unspecified",
      date: isoDate(date),
      screenCapture: values.capture ?? [],
    });
    const out = resolve(ROOT, values.out ?? "target/friday");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "settlement-entry.md"), entry);
    writeFileSync(resolve(out, "settlement.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(entry);
    return judge(evidence).ok ? 0 : 1;
  } catch (error) {
    throw chain.redact(error);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
