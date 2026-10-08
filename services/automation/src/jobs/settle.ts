/**
 * The settlement job (FR-14, NFR-04, NFR-06; domain.md § Settlement rules): at close + 5 minutes
 * (early-close aware, it simply follows each market's `close_ts`) settle every open market.
 *
 * Per ticker and trading date: first the off-chain date check (both data sources must report the
 * market's trading date as their latest daily bar, else NOTHING is sent: AB-03), then one
 * oracle-update + `settle_market` transaction set (see `settleTx.ts`). A failing ticker is
 * retried every 30 s for 15 minutes; after that one alert and one incident (`POST /incidents`)
 * are sent. Settled markets are skipped, so a re-run after success sends nothing (NFR-05).
 *
 * `settle_market` is permissionless: the payer only pays fees. The job never reads or needs the
 * automation key beyond using it as that payer (AB-19).
 */
import { type PublicKey } from "@solana/web3.js";
import type { TransactionInstruction } from "@solana/web3.js";

import type { Alerter } from "../alerts";
import { type IsoDate } from "../calendar";
import type { IncidentClient } from "../incidents";
import { describeError, type Logger } from "../log";
import type { PrevCloseResult } from "../prevCloses";
import type { JobSpec } from "../scheduler";
import type { OracleUpdateAdapter } from "../switchboard";
import { type RunState } from "../state";
import { planSettlement, sendPlan, type TxExecutor } from "../settleTx";

/** The job checks for due markets every minute. */
export const SETTLEMENT_CRON = "* * * * *";
/** Settle this long after `close_ts` (domain.md: close + 5 min). */
export const SETTLE_DELAY_SECS = 300;
export const RETRY_EVERY_MS = 30_000;
export const RETRY_WINDOW_MS = 15 * 60_000;
/** Slots kept free of `max_staleness_slots` when sending the second transaction of a split. */
export const SLOT_MARGIN = 10;
/** Alert when the payer holds less than this (devnet fees are tiny; 0.05 SOL covers many runs). */
export const MIN_BALANCE_LAMPORTS = 50_000_000;

export interface OpenMarket {
  readonly address: PublicKey;
  readonly ticker: string;
  /** `YYYYMMDD`. */
  readonly tradingDate: number;
  readonly closeTs: number;
  readonly strikeCents: bigint;
}

export interface PinnedFeeds {
  readonly feeds: Readonly<Record<string, readonly [PublicKey, PublicKey]>>;
  readonly maxStalenessSlots: number;
}

/** Read-only view of the chain the job needs. */
export interface SettleChain {
  openMarkets(): Promise<readonly OpenMarket[]>;
  pinnedFeeds(): Promise<PinnedFeeds>;
  balanceLamports(): Promise<number>;
}

export interface SettleOptions {
  readonly delaySecs: number;
  readonly retryEveryMs: number;
  readonly windowMs: number;
  readonly minBalanceLamports: number;
  /** Restricts the run to this ET date (`settle-now --date`). */
  readonly onlyDate?: IsoDate;
}

export const JOB_OPTIONS: SettleOptions = {
  delaySecs: SETTLE_DELAY_SECS,
  retryEveryMs: RETRY_EVERY_MS,
  windowMs: RETRY_WINDOW_MS,
  minBalanceLamports: MIN_BALANCE_LAMPORTS,
};

export interface SettleDeps {
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly chain: SettleChain;
  /** Both sources' bar for `date` (the market's trading date); not ok = wrong date or sources disagree. */
  readonly verifyClose: (ticker: string, date: IsoDate) => Promise<PrevCloseResult>;
  readonly adapter: OracleUpdateAdapter;
  /** `settle_market` instructions for the markets, with exactly the given pinned feeds. */
  readonly buildSettleIxs: (
    markets: readonly OpenMarket[],
    feeds: readonly [PublicKey, PublicKey],
  ) => Promise<TransactionInstruction[]>;
  readonly payer: PublicKey;
  readonly executor: TxExecutor;
  readonly alerter: Alerter;
  readonly incidents: IncidentClient;
  readonly state: RunState;
  readonly log: Logger;
  readonly options: SettleOptions;
  /** Survives across runs of one process: what was already alerted. */
  readonly memory?: SettleMemory;
}

export class SettleMemory {
  readonly alerted = new Set<string>();
  lowBalanceAlerted = false;
}

export interface SettleResult {
  /** `idle`: nothing was due. */
  readonly status: "idle" | "ok" | "failed";
  readonly settled: number;
  readonly attempts: number;
  readonly failures: readonly { readonly group: string; readonly reason: string }[];
}

export function isoDate(tradingDate: number): IsoDate {
  const text = String(tradingDate);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function groupKey(market: OpenMarket): string {
  return `${market.ticker}:${isoDate(market.tradingDate)}`;
}

/** Due, open markets grouped by ticker and trading date. */
function dueGroups(
  open: readonly OpenMarket[],
  nowMs: number,
  options: SettleOptions,
): Map<string, OpenMarket[]> {
  const groups = new Map<string, OpenMarket[]>();
  for (const market of open) {
    if (nowMs < (market.closeTs + options.delaySecs) * 1_000) {
      continue;
    }
    if (options.onlyDate !== undefined && isoDate(market.tradingDate) !== options.onlyDate) {
      continue;
    }
    groups.set(groupKey(market), [...(groups.get(groupKey(market)) ?? []), market]);
  }
  return groups;
}

export async function runSettlement(deps: SettleDeps): Promise<SettleResult> {
  const { options } = deps;
  const memory = deps.memory ?? new SettleMemory();
  const startedAt = deps.now();
  const initial = dueGroups(await deps.chain.openMarkets(), startedAt.getTime(), options);
  if (initial.size === 0) {
    return { status: "idle", settled: 0, attempts: 0, failures: [] };
  }

  const pending = new Set(initial.keys());
  const lastError = new Map<string, string>();
  // A group whose 15 minutes are over and was alerted is retried quietly, one attempt per run.
  const quiet = [...pending].every((key) => memory.alerted.has(key));
  const windowMs = quiet ? 0 : options.windowMs;
  let settled = 0;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const open = await deps.chain.openMarkets();
    const groups = dueGroups(open, deps.now().getTime(), options);
    for (const key of [...pending]) {
      const markets = groups.get(key);
      if (markets === undefined || markets.length === 0) {
        pending.delete(key); // settled meanwhile (by us or by anyone: it is permissionless)
        lastError.delete(key);
        memory.alerted.delete(key);
        continue;
      }
      try {
        await settleGroup(deps, memory, key, markets);
        settled += markets.length;
        pending.delete(key);
        lastError.delete(key);
        memory.alerted.delete(key);
      } catch (error) {
        const reason = describeError(error);
        lastError.set(key, reason);
        deps.log("warn", "settle_attempt_failed", { group: key, attempt: attempts, reason });
      }
    }
    if (pending.size === 0) {
      break;
    }
    const elapsed = deps.now().getTime() - startedAt.getTime();
    if (elapsed >= windowMs) {
      break;
    }
    await deps.sleep(Math.min(options.retryEveryMs, windowMs - elapsed));
  }

  const failures = [...pending].map((group) => ({
    group,
    reason: lastError.get(group) ?? "unknown",
  }));
  const status = failures.length === 0 ? "ok" : "failed";
  deps.state.record({
    job: "settlement",
    tradingDate: isoDate([...initial.values()][0]?.[0]?.tradingDate ?? 0),
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    created: 0,
    existed: 0,
    settled,
    attempts,
    notes: failures.map((f) => `${f.group}: ${f.reason}`),
  });
  const fresh = failures.filter((f) => !memory.alerted.has(f.group));
  if (fresh.length > 0) {
    for (const f of fresh) {
      memory.alerted.add(f.group);
    }
    const tickers = [...new Set(fresh.map((f) => f.group.split(":")[0] ?? ""))];
    const reasons = fresh.map((f) => `${f.group}: ${f.reason}`);
    await deps.alerter.send({
      kind: "settlement_failed",
      summary: `could not settle ${fresh.map((f) => f.group).join(", ")} after ${String(attempts)} attempts`,
      details: { groups: fresh.map((f) => f.group), reasons, attempts },
    });
    await deps.incidents.post({
      kind: "settlement_failed",
      tradingDate: fresh[0]?.group.split(":")[1] ?? "",
      tickers,
      reasons,
      at: deps.now().toISOString(),
    });
  }
  return { status, settled, attempts, failures };
}

/** One ticker on one date: verify the date, update the oracle, settle every open market. */
async function settleGroup(
  deps: SettleDeps,
  memory: SettleMemory,
  key: string,
  markets: readonly OpenMarket[],
): Promise<void> {
  const first = markets[0];
  if (first === undefined) {
    return;
  }
  const date = isoDate(first.tradingDate);

  // AB-03: nothing is sent unless both sources report this trading date's close.
  const close = await deps.verifyClose(first.ticker, date);
  if (!close.ok) {
    throw new Error(`${close.error.kind}: ${close.error.message}`);
  }

  const pinned = await deps.chain.pinnedFeeds();
  const feeds = pinned.feeds[first.ticker];
  if (feeds === undefined) {
    throw new Error(`no feeds pinned in the config for ${first.ticker}`);
  }

  const balance = await deps.chain.balanceLamports();
  if (balance < deps.options.minBalanceLamports && !memory.lowBalanceAlerted) {
    memory.lowBalanceAlerted = true;
    await deps.alerter.send({
      kind: "settlement_low_balance",
      summary: `the settlement payer holds ${String(balance)} lamports, below ${String(deps.options.minBalanceLamports)}; fund it`,
      details: { lamports: balance },
    });
  }

  const slot = await deps.executor.currentSlot();
  const update = await deps.adapter.build({
    ticker: first.ticker,
    closeCents: close.value.closeCents,
    feeds,
    slot,
  });
  // Only the Config-pinned feeds are ever passed (AB-04).
  const settleIxs = await deps.buildSettleIxs(markets, feeds);
  const plan = planSettlement({
    payer: deps.payer,
    updateIxs: update.ixs,
    luts: update.luts,
    settleIxs,
  });
  const report = await sendPlan({
    plan,
    executor: deps.executor,
    signers: update.signers,
    budgetSlots: Math.max(1, pinned.maxStalenessSlots - SLOT_MARGIN),
  });
  deps.log("info", "settled", {
    group: key,
    markets: markets.length,
    shape: plan.shape,
    transactions: report.signatures.length,
    reUpdates: report.reUpdates,
    signatures: report.signatures,
  });
}

/** The scheduled job; `signer` is the public key of the payer. */
export function createSettlementJob(deps: SettleDeps): JobSpec {
  const memory = deps.memory ?? new SettleMemory();
  return {
    name: "settlement",
    cron: SETTLEMENT_CRON,
    signer: deps.payer.toBase58(),
    run: async () => {
      await runSettlement({ ...deps, memory });
    },
  };
}
