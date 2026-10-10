/**
 * The settlement job (FR-14, NFR-04, NFR-06; domain.md § Settlement rules): from close + 5 minutes
 * settle every open market, per ticker and trading date ("group").
 *
 * Per group: first the off-chain date check (both data sources must report the market's trading
 * date as their latest daily bar, else NOTHING is sent: AB-03), then one oracle-update +
 * `settle_market` transaction set (see `settleTx.ts`). Settled markets are skipped, so a re-run
 * after success sends nothing (NFR-05).
 *
 * Pacing (#53). The job runs every minute and every attempt costs data-API requests (Tiingo and
 * Twelve Data, and on devnet the Switchboard oracles fetch both again with our keys), so:
 * - A group is only considered once its trading date's regular session has really completed: an
 *   NYSE trading day whose official close (16:00 ET, or 13:00 ET on early closes) plus the settle
 *   delay has passed in real time, whatever the market's on-chain `close_ts` says. Weekend or
 *   holiday groups (deliberate demo markets) and future sessions are logged once per process and
 *   never reach the data APIs; an admin settles weekend demo markets by override.
 * - At most one attempt per group per run, and at most `maxApiCallsPerRun` data-API requests per
 *   run (each attempt reserves its worst case up front). Groups that do not fit wait for the next
 *   run, least recently attempted first, so a backlog (e.g. a cold start after a redeploy, when
 *   this in-process memory is empty) is spread over several runs instead of bursting.
 * - A rate limit (HTTP 429, honouring `Retry-After`) stops the run's remaining attempts and pauses
 *   every data-API request across runs with exponential backoff (2, 4, 8 ... minutes, capped at
 *   60), reset by the next answer that is not a rate limit.
 * - A failing group is retried on later runs (about once a minute) for 15 minutes from its first
 *   failure; then one alert and one incident (`POST /incidents`) are sent. After that it is retried
 *   quietly every 15 minutes, at most 8 times (two hours), then left to the `settle-now` CLI.
 *
 * With `PYTH_SETTLEMENT_ENABLED=true` (off by default) a group is settled from Pyth's signed close
 * instead (`pythSettle.ts`, D-055): same date check, pacing and retries, but no oracle update is
 * built; failures follow the same alert path, and the admin override stays the fallback.
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
import type { PythSettler } from "../pythSettle";
import type { JobSpec } from "../scheduler";
import type { OracleUpdateAdapter } from "../switchboard";
import { type RunState } from "../state";
import { planSettlement, planUpdateTx, sendPlan, type TxExecutor } from "../settleTx";
import {
  attemptCost,
  backoffUntil,
  DEFAULT_MAX_API_CALLS_PER_RUN,
  parseRetryAfterMs,
  sessionGate,
  VERIFY_API_CALLS,
  type SkipReason,
} from "../settlePacing";

/** The job checks for due markets every minute (one attempt per group per run). */
export const SETTLEMENT_CRON = "* * * * *";
/** Settle this long after the close (domain.md: close + 5 min). */
export const SETTLE_DELAY_SECS = 300;
/** A failing group is retried on every run for this long after its first failure, then alerted. */
export const RETRY_WINDOW_MS = 15 * 60_000;
/**
 * After the 15-minute window and the alert, a still-failing group is retried quietly this often,
 * at most [`MAX_QUIET_ATTEMPTS`] times (two hours), then left to `settle-now`, so a group that
 * cannot settle never burns the Twelve Data daily quota the next morning's job needs.
 */
export const QUIET_RETRY_MS = 15 * 60_000;
export const MAX_QUIET_ATTEMPTS = 8;
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
  /** Seconds after both the market's `close_ts` and the session's official close. */
  readonly delaySecs: number;
  /** How long a failing group is retried before the alert (0: alert on the first failure). */
  readonly windowMs: number;
  readonly minBalanceLamports: number;
  /** Data-API requests one run may cause, oracle-side fetches included (#53). */
  readonly maxApiCallsPerRun: number;
  /** Restricts the run to this ET date (`settle-now --date`). */
  readonly onlyDate?: IsoDate;
}

export const JOB_OPTIONS: SettleOptions = {
  delaySecs: SETTLE_DELAY_SECS,
  windowMs: RETRY_WINDOW_MS,
  minBalanceLamports: MIN_BALANCE_LAMPORTS,
  maxApiCallsPerRun: DEFAULT_MAX_API_CALLS_PER_RUN,
};

export interface SettleDeps {
  readonly now: () => Date;
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
  /** Set only when Pyth settlement is enabled; replaces the oracle update + settle path. */
  readonly pyth?: PythSettler | undefined;
  readonly alerter: Alerter;
  readonly incidents: IncidentClient;
  readonly state: RunState;
  readonly log: Logger;
  readonly options: SettleOptions;
  /** Survives across runs of one process: retry schedule, alerts, rate-limit backoff. */
  readonly memory?: SettleMemory;
}

/**
 * What the job remembers between runs. In-process only: a redeploy starts empty, which is why the
 * per-run cap (not this memory) is what bounds a cold start.
 */
export class SettleMemory {
  readonly alerted = new Set<string>();
  /** Start of each failing group's 15-minute window. */
  readonly firstFailureMs = new Map<string, number>();
  readonly lastAttemptMs = new Map<string, number>();
  readonly attempts = new Map<string, number>();
  readonly lastError = new Map<string, string>();
  /** Attempts made after the alert. */
  readonly quietAttempts = new Map<string, number>();
  readonly gaveUp = new Set<string>();
  /** `group|reason` already logged as skipped (no completed session). */
  readonly skipLogged = new Set<string>();
  /** No data-API request before this instant (rate-limit backoff, shared by every group). */
  backoffUntilMs = 0;
  /** Consecutive rate limits; the backoff doubles with each. */
  rateLimitStrikes = 0;
  /** The backoff episode already logged as deferring groups. */
  backoffLoggedUntilMs = 0;
  lowBalanceAlerted = false;

  forget(group: string): void {
    this.alerted.delete(group);
    this.firstFailureMs.delete(group);
    this.lastAttemptMs.delete(group);
    this.attempts.delete(group);
    this.lastError.delete(group);
    this.quietAttempts.delete(group);
    this.gaveUp.delete(group);
    for (const entry of [...this.skipLogged]) {
      if (entry.startsWith(`${group}|`)) {
        this.skipLogged.delete(entry);
      }
    }
  }

  /** Forgets every group that is no longer open and due (settled by us, by anyone, or overridden). */
  retain(groups: ReadonlySet<string>): void {
    const known = [
      ...this.alerted,
      ...this.lastAttemptMs.keys(),
      ...this.firstFailureMs.keys(),
      ...[...this.skipLogged].map((entry) => entry.split("|")[0] ?? ""),
    ];
    for (const group of new Set(known)) {
      if (!groups.has(group)) {
        this.forget(group);
      }
    }
  }
}

export interface SettleResult {
  /** `idle`: no attempt was made (nothing due, or everything due was skipped or deferred). */
  readonly status: "idle" | "ok" | "failed";
  readonly settled: number;
  /** Group attempts made by this run (at most one per group). */
  readonly attempts: number;
  readonly failures: readonly { readonly group: string; readonly reason: string }[];
  /** Due groups whose session has not completed: never sent to the data APIs. */
  readonly skipped: readonly { readonly group: string; readonly reason: SkipReason }[];
  /** Groups left for a later run by the per-run cap or the rate-limit backoff. */
  readonly deferred: readonly string[];
}

/** Thrown by an attempt that a data source rate-limited. */
export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfter: string | null,
  ) {
    super(message);
    this.name = "RateLimitedError";
  }
}

export function isoDate(tradingDate: number): IsoDate {
  const text = String(tradingDate);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function groupKey(market: OpenMarket): string {
  return `${market.ticker}:${isoDate(market.tradingDate)}`;
}

/** Open markets past their `close_ts` + delay, grouped by ticker and trading date. */
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

interface Candidates {
  /** Groups to attempt this run, in order: least recently attempted first. */
  readonly eligible: string[];
  readonly skipped: { readonly group: string; readonly reason: SkipReason }[];
}

/** Drops groups without a completed session and alerted groups not yet due for a quiet retry. */
function selectCandidates(
  deps: SettleDeps,
  memory: SettleMemory,
  due: ReadonlyMap<string, readonly OpenMarket[]>,
  nowMs: number,
): Candidates {
  const eligible: string[] = [];
  const skipped: { group: string; reason: SkipReason }[] = [];
  for (const [key, markets] of due) {
    const tradingDate = markets[0]?.tradingDate ?? 0;
    const gate = sessionGate(isoDate(tradingDate), nowMs, deps.options.delaySecs);
    if (!gate.ok) {
      skipped.push({ group: key, reason: gate.reason });
      if (!memory.skipLogged.has(`${key}|${gate.reason}`)) {
        memory.skipLogged.add(`${key}|${gate.reason}`);
        deps.log("info", "settle_skipped_no_session", {
          group: key,
          reason: gate.reason,
          detail: gate.detail,
          markets: markets.length,
        });
      }
      continue;
    }
    if (memory.alerted.has(key)) {
      const quiet = memory.quietAttempts.get(key) ?? 0;
      if (quiet >= MAX_QUIET_ATTEMPTS) {
        if (!memory.gaveUp.has(key)) {
          memory.gaveUp.add(key);
          deps.log("error", "settlement_gave_up", { group: key, quietAttempts: quiet });
        }
        continue;
      }
      if (nowMs - (memory.lastAttemptMs.get(key) ?? 0) < QUIET_RETRY_MS) {
        continue;
      }
    }
    eligible.push(key);
  }
  const last = (key: string): number => memory.lastAttemptMs.get(key) ?? -1;
  eligible.sort((a, b) => last(a) - last(b) || a.localeCompare(b));
  return { eligible, skipped };
}

interface Attempts {
  settled: number;
  readonly attempted: string[];
  readonly failed: Map<string, string>;
  readonly deferred: string[];
}

/** At most one attempt per candidate, within the run's data-API budget and outside any backoff. */
async function attemptCandidates(
  deps: SettleDeps,
  memory: SettleMemory,
  due: ReadonlyMap<string, readonly OpenMarket[]>,
  candidates: readonly string[],
): Promise<Attempts> {
  const cap = deps.options.maxApiCallsPerRun;
  const cost = attemptCost(deps.adapter.kind);
  const perUpdate = cost - VERIFY_API_CALLS;
  // Every oracle update is counted: re-updates of a split plan are charged after the fact.
  let updates = 0;
  const adapter: OracleUpdateAdapter = {
    kind: deps.adapter.kind,
    build: (request) => {
      updates += 1;
      return deps.adapter.build(request);
    },
  };
  const out: Attempts = { settled: 0, attempted: [], failed: new Map(), deferred: [] };
  let spent = 0;
  for (const key of candidates) {
    const markets = due.get(key) ?? [];
    const nowMs = deps.now().getTime();
    if (markets.length === 0 || nowMs < memory.backoffUntilMs || spent + cost > cap) {
      out.deferred.push(key);
      continue;
    }
    const updatesBefore = updates;
    out.attempted.push(key);
    memory.lastAttemptMs.set(key, nowMs);
    memory.attempts.set(key, (memory.attempts.get(key) ?? 0) + 1);
    if (memory.alerted.has(key)) {
      memory.quietAttempts.set(key, (memory.quietAttempts.get(key) ?? 0) + 1);
    }
    try {
      await settleGroup({ ...deps, adapter }, memory, key, markets);
      out.settled += markets.length;
      memory.forget(key);
      memory.rateLimitStrikes = 0;
    } catch (error) {
      const reason = describeError(error);
      out.failed.set(key, reason);
      memory.lastError.set(key, reason);
      if (!memory.firstFailureMs.has(key)) {
        memory.firstFailureMs.set(key, nowMs);
      }
      deps.log("warn", "settle_attempt_failed", {
        group: key,
        attempt: memory.attempts.get(key),
        reason,
      });
      if (error instanceof RateLimitedError) {
        startBackoff(deps, memory, key, error);
      } else {
        memory.rateLimitStrikes = 0;
      }
    } finally {
      spent += VERIFY_API_CALLS + (updates - updatesBefore) * perUpdate;
    }
  }
  logDeferred(deps, memory, out.deferred, spent);
  return out;
}

function startBackoff(
  deps: SettleDeps,
  memory: SettleMemory,
  group: string,
  error: RateLimitedError,
): void {
  const nowMs = deps.now().getTime();
  memory.rateLimitStrikes += 1;
  memory.backoffUntilMs = backoffUntil(
    nowMs,
    memory.rateLimitStrikes,
    parseRetryAfterMs(error.retryAfter, nowMs),
  );
  deps.log("warn", "settle_rate_limited", {
    group,
    strikes: memory.rateLimitStrikes,
    retryAfter: error.retryAfter,
    resumeAt: new Date(memory.backoffUntilMs).toISOString(),
  });
}

/** One line per run while the budget defers groups; one line per backoff episode. */
function logDeferred(
  deps: SettleDeps,
  memory: SettleMemory,
  deferred: readonly string[],
  spent: number,
): void {
  if (deferred.length === 0) {
    return;
  }
  const backingOff = deps.now().getTime() < memory.backoffUntilMs;
  if (backingOff && memory.backoffLoggedUntilMs === memory.backoffUntilMs) {
    return;
  }
  if (backingOff) {
    memory.backoffLoggedUntilMs = memory.backoffUntilMs;
  }
  deps.log("info", "settle_deferred", {
    groups: deferred.length,
    reason: backingOff ? "rate_limit_backoff" : "api_budget",
    apiCallsThisRun: spent,
    maxApiCallsPerRun: deps.options.maxApiCallsPerRun,
    ...(backingOff ? { resumeAt: new Date(memory.backoffUntilMs).toISOString() } : {}),
  });
}

export async function runSettlement(deps: SettleDeps): Promise<SettleResult> {
  const { options } = deps;
  const memory = deps.memory ?? new SettleMemory();
  const startedAt = deps.now();
  const due = dueGroups(await deps.chain.openMarkets(), startedAt.getTime(), options);
  memory.retain(new Set(due.keys()));
  const { eligible, skipped } = selectCandidates(deps, memory, due, startedAt.getTime());
  const run = await attemptCandidates(deps, memory, due, eligible);

  // Groups whose window is over (counted from their first failure) are alerted once, even when
  // this run deferred them: a sustained rate limit must still reach the operator.
  const nowMs = deps.now().getTime();
  const fresh = [...due.keys()].filter((key) => {
    const first = memory.firstFailureMs.get(key);
    return !memory.alerted.has(key) && first !== undefined && nowMs - first >= options.windowMs;
  });
  const failed = [...new Set([...run.failed.keys(), ...fresh])];
  const failures = failed.map((group) => ({
    group,
    reason: run.failed.get(group) ?? memory.lastError.get(group) ?? "unknown",
  }));
  const base = { settled: run.settled, attempts: run.attempted.length, skipped };
  if (run.attempted.length === 0 && fresh.length === 0) {
    return { status: "idle", ...base, failures: [], deferred: run.deferred };
  }
  const status = failures.length === 0 ? "ok" : "failed";
  const firstGroup = run.attempted[0] ?? failed[0] ?? "";
  deps.state.record({
    job: "settlement",
    tradingDate: firstGroup.split(":")[1] ?? "",
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    created: 0,
    existed: 0,
    settled: run.settled,
    attempts: run.attempted.length,
    notes: failures.map((f) => `${f.group}: ${f.reason}`),
  });
  if (fresh.length > 0) {
    await alertFresh(deps, memory, fresh);
  }
  return { status, ...base, failures, deferred: run.deferred };
}

async function alertFresh(
  deps: SettleDeps,
  memory: SettleMemory,
  fresh: readonly string[],
): Promise<void> {
  for (const group of fresh) {
    memory.alerted.add(group);
    memory.quietAttempts.set(group, 0);
  }
  const attempts = Math.max(...fresh.map((group) => memory.attempts.get(group) ?? 0));
  const reasons = fresh.map((group) => `${group}: ${memory.lastError.get(group) ?? "unknown"}`);
  await deps.alerter.send({
    kind: "settlement_failed",
    summary:
      `could not settle ${fresh.join(", ")} after ${String(attempts)} attempts; ` +
      "it is retried quietly every 15 minutes for two hours, or settle it now with the settle-now CLI",
    details: { groups: fresh, reasons, attempts },
  });
  await deps.incidents.post({
    kind: "settlement_failed",
    tradingDate: fresh[0]?.split(":")[1] ?? "",
    tickers: [...new Set(fresh.map((group) => group.split(":")[0] ?? ""))],
    reasons,
    at: deps.now().toISOString(),
  });
}

/**
 * Alerts once per low-balance episode: the flag resets as soon as the balance is back above the
 * threshold, so a later drop alerts again. Called at startup and before every settlement.
 */
export async function checkBalance(
  deps: Pick<SettleDeps, "chain" | "alerter" | "options">,
  memory: SettleMemory,
): Promise<void> {
  const balance = await deps.chain.balanceLamports();
  if (balance >= deps.options.minBalanceLamports) {
    memory.lowBalanceAlerted = false;
    return;
  }
  if (!memory.lowBalanceAlerted) {
    memory.lowBalanceAlerted = true;
    await deps.alerter.send({
      kind: "settlement_low_balance",
      summary: `the settlement payer holds ${String(balance)} lamports, below ${String(deps.options.minBalanceLamports)}; fund it`,
      details: { lamports: balance },
    });
  }
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
    const message = `${close.error.kind}: ${close.error.message}`;
    if (close.error.rateLimit !== undefined) {
      throw new RateLimitedError(message, close.error.rateLimit.retryAfter);
    }
    throw new Error(message);
  }

  const pinned = await deps.chain.pinnedFeeds();
  const feeds = pinned.feeds[first.ticker];
  if (feeds === undefined) {
    throw new Error(`no feeds pinned in the config for ${first.ticker}`);
  }

  // A balance check that cannot be made must not stop a settlement.
  await checkBalance(deps, memory).catch((error: unknown) => {
    deps.log("warn", "balance_check_failed", { error: describeError(error) });
  });

  if (deps.pyth !== undefined) {
    await settleGroupFromPyth(deps, deps.pyth, key, markets, feeds, close.value.closeCents);
    return;
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
    // A re-update asks the oracle again at the current slot; it never replays the old payload.
    refreshUpdate: async () => {
      const fresh = await deps.adapter.build({
        ticker: first.ticker,
        closeCents: close.value.closeCents,
        feeds,
        slot: await deps.executor.currentSlot(),
      });
      return { tx: planUpdateTx(deps.payer, fresh.ixs, fresh.luts), signers: fresh.signers };
    },
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

/** The Pyth path of [`settleGroup`]; logs Pyth's close next to the official one. */
async function settleGroupFromPyth(
  deps: SettleDeps,
  pyth: PythSettler,
  key: string,
  markets: readonly OpenMarket[],
  feeds: readonly [PublicKey, PublicKey],
  officialCents: number,
): Promise<void> {
  const reports = await pyth.settle(markets, feeds);
  for (const report of reports) {
    deps.log("info", "settled", {
      group: key,
      source: "pyth",
      closeTs: report.closeTs,
      markets: report.markets,
      transactions: report.signatures.length,
      signatures: report.signatures,
      pythCents: Number(report.priceCents),
      officialCents,
      pythVsOfficialBps: bpsDiff(report.priceCents, officialCents),
      confidenceBps: report.confidenceBps,
    });
  }
}

/** (pyth − official) / official in basis points, two decimals (logs only). */
function bpsDiff(pythCents: bigint, officialCents: number): number {
  return Math.round(((Number(pythCents) - officialCents) / officialCents) * 1_000_000) / 100;
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
