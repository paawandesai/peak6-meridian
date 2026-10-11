/**
 * The Pyth settlement path (D-055), used by the settlement job and `settle-now` only when
 * `PYTH_SETTLEMENT_ENABLED=true`; the default stays the oracle-update path in `settleTx.ts`.
 *
 * Per ticker and close time: read the Pyth fields of the on-chain Config (signer, feed id, close
 * window, `max_conf_bps`), fetch the update Pyth signed at `close_ts`, refuse it off-chain with
 * the program's own rules, then send `[Ed25519 verify, settle_market × n]` transactions. The
 * signed update does not go stale by slot (the program checks it against the close, not the
 * current time), so every transaction carries the same Ed25519 instruction at index 0 and a
 * split needs no re-fetch.
 */
import { type Program } from "@coral-xyz/anchor";
import { type Meridian, symbolFromBytes } from "@meridian/client";
import {
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { OpenMarket } from "./jobs/settle";
import { checkSignedClose, confidenceBps, priceCents, type SignedPythUpdate } from "./pythLazer";
import { MAX_TX_BYTES, serializedSize, type PlannedTx, type TxExecutor } from "./settleTx";

/** The Ed25519 instruction is always the first one of a Pyth settlement transaction. */
export const ED25519_IX_INDEX = 0;

/** The Pyth fields of the on-chain Config, as automation needs them. */
export interface PythChainConfig {
  readonly signer: PublicKey;
  /** By ticker; tickers with feed id 0 (not configured) are absent. */
  readonly feedIds: Readonly<Record<string, number>>;
  /** `pyth_max_age_secs`: the update must be taken in `[close_ts, close_ts + this]`. */
  readonly closeWindowSecs: number;
  readonly maxConfBps: number;
}

export async function readPythConfig(
  program: Program<Meridian>,
  config: PublicKey,
): Promise<PythChainConfig> {
  const account = await program.account.config.fetch(config);
  const feedIds: Record<string, number> = {};
  account.tickers.forEach((ticker, index) => {
    const symbol = symbolFromBytes(ticker.symbol);
    const feedId = account.pythFeedIds[index];
    if (symbol !== "" && feedId !== undefined && feedId !== 0) {
      feedIds[symbol] = feedId;
    }
  });
  return {
    signer: account.pythLazerSigner,
    feedIds,
    closeWindowSecs: Number(account.pythMaxAgeSecs.toString()),
    maxConfBps: account.maxConfBps,
  };
}

/** The native Ed25519 verify instruction for the update, every offset inside itself. */
export function pythEd25519Ix(update: SignedPythUpdate): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: update.publicKey,
    message: update.payload,
    signature: update.signature,
  });
}

/** `settle_market` on the Pyth path for each market (Ed25519 instruction at index 0). */
export async function buildPythSettleInstructions(params: {
  readonly program: Program<Meridian>;
  readonly config: PublicKey;
  readonly payer: PublicKey;
  readonly markets: readonly PublicKey[];
  /** Config-pinned legacy feeds: required accounts, ignored by the Pyth path. */
  readonly feeds: readonly [PublicKey, PublicKey];
}): Promise<TransactionInstruction[]> {
  const out: TransactionInstruction[] = [];
  for (const market of params.markets) {
    out.push(
      await params.program.methods
        .settleMarket(ED25519_IX_INDEX)
        .accountsStrict({
          config: params.config,
          market,
          feedTiingo: params.feeds[0],
          feedTwelveData: params.feeds[1],
          redstonePrice: null,
          oracleConfig: null,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          payer: params.payer,
        })
        .instruction(),
    );
  }
  return out;
}

/** Fewest legacy transactions `[ed25519, settle…]` that fit the packet limit. */
export function planPythSettlement(
  payer: PublicKey,
  ed25519Ix: TransactionInstruction,
  settleIxs: readonly TransactionInstruction[],
): PlannedTx[] {
  const txs: PlannedTx[] = [];
  let batch: TransactionInstruction[] = [];
  const fits = (ixs: readonly TransactionInstruction[]): number | null => {
    try {
      const size = serializedSize(payer, [ed25519Ix, ...ixs], [], false);
      return size <= MAX_TX_BYTES ? size : null;
    } catch {
      return null;
    }
  };
  const flush = (): void => {
    const size = fits(batch);
    if (batch.length === 0 || size === null) {
      return;
    }
    txs.push({
      role: "update+settle",
      versioned: false,
      instructions: [ed25519Ix, ...batch],
      luts: [],
      size,
      settles: batch.length,
    });
    batch = [];
  };
  for (const ix of settleIxs) {
    if (fits([...batch, ix]) === null) {
      if (batch.length === 0) {
        throw new Error("one settle_market with the Pyth update does not fit in a transaction");
      }
      flush();
    }
    batch.push(ix);
  }
  flush();
  return txs;
}

export interface PythSettleReport {
  readonly closeTs: number;
  readonly markets: number;
  readonly priceCents: bigint;
  readonly confidenceBps: number;
  readonly signatures: readonly string[];
}

/** Settles one group (one ticker, one trading date) from Pyth's signed closes. */
export interface PythSettler {
  settle(
    markets: readonly OpenMarket[],
    feeds: readonly [PublicKey, PublicKey],
  ): Promise<PythSettleReport[]>;
}

export interface PythSettlerDeps {
  readonly readConfig: () => Promise<PythChainConfig>;
  readonly fetchSigned: (feedId: number, timestampUs: bigint) => Promise<SignedPythUpdate>;
  readonly buildSettleIxs: (
    markets: readonly OpenMarket[],
    feeds: readonly [PublicKey, PublicKey],
  ) => Promise<TransactionInstruction[]>;
  readonly payer: PublicKey;
  readonly executor: TxExecutor;
  readonly now: () => Date;
}

/** Throws unless the Config carries everything the Pyth path needs for `ticker`. */
function requireConfigured(config: PythChainConfig, ticker: string): number {
  if (config.signer.equals(PublicKey.default)) {
    throw new Error("pyth_lazer_signer is not set in the Config (see the Pyth settlement runbook)");
  }
  if (config.closeWindowSecs <= 0) {
    throw new Error("pyth_max_age_secs is not set in the Config");
  }
  const feedId = config.feedIds[ticker];
  if (feedId === undefined) {
    throw new Error(`no Pyth feed id in the Config for ${ticker}`);
  }
  return feedId;
}

export function createPythSettler(deps: PythSettlerDeps): PythSettler {
  return {
    async settle(markets, feeds) {
      const ticker = markets[0]?.ticker;
      if (ticker === undefined) {
        return [];
      }
      const config = await deps.readConfig();
      const feedId = requireConfigured(config, ticker);
      // Markets of one group normally share close_ts; demo markets may not, so each close
      // time gets its own signed update.
      const byClose = new Map<number, OpenMarket[]>();
      for (const market of markets) {
        byClose.set(market.closeTs, [...(byClose.get(market.closeTs) ?? []), market]);
      }
      const reports: PythSettleReport[] = [];
      for (const [closeTs, group] of byClose) {
        const update = await deps.fetchSigned(feedId, BigInt(closeTs) * 1_000_000n);
        checkSignedClose(update, {
          signer: config.signer.toBytes(),
          feedId,
          closeTs,
          closeWindowSecs: config.closeWindowSecs,
          maxConfBps: config.maxConfBps,
          nowSecs: Math.floor(deps.now().getTime() / 1_000),
        });
        const settleIxs = await deps.buildSettleIxs(group, feeds);
        const signatures: string[] = [];
        for (const tx of planPythSettlement(deps.payer, pythEd25519Ix(update), settleIxs)) {
          signatures.push((await deps.executor.send(tx, [])).signature);
        }
        reports.push({
          closeTs,
          markets: group.length,
          priceCents: priceCents(update.parsed),
          confidenceBps: confidenceBps(update.parsed),
          signatures,
        });
      }
      return reports;
    },
  };
}
