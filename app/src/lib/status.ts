/**
 * /status data model (M3-04, US-19, UI-07). Pure and integer-only: the vault invariant in USDC
 * base units, times in unix seconds, oracle age in slots. Rows come from on-chain accounts
 * (`MarketRow`, vault balances) and the M2-05 decoder's events (`MarketCreated`, `MarketSettled`);
 * nothing here parses logs or reads a clock.
 */
import type { MeridianEvent } from "./events";
import { SETTLEMENT_DELAYED_SECS, type MarketRow } from "./markets";

/** 1 USDC per pair, in base units (domain.md § Invariants, 1). */
export const BASE_UNITS_PER_PAIR = 1_000_000n;
/** Creation must be done by 09:00 ET (domain.md daily schedule). */
export const CREATION_DEADLINE_ET = { hour: 9, minute: 0 } as const;
/** Settlement counts as on time up to the "Settlement delayed" threshold (close + 20 min). */
export const ON_TIME_SETTLE_SECS = SETTLEMENT_DELAYED_SECS;
/** Solana targets 400 ms slots; used only to give oracle age a rough seconds figure. */
export const SLOT_MS = 400n;
export const BOOK_COVERAGE_TEXT = "Book coverage: not running";

export type Verdict = "Pass" | "Fail";

export type InvariantRow = {
  readonly market: string;
  readonly verdict: Verdict;
  /** `pairs × 1,000,000`. */
  readonly expected: bigint;
  /** The vault's USDC base units, or `null` when the vault could not be read. */
  readonly actual: bigint | null;
};

/** Vault vs pairs outstanding × $1. An unreadable vault is a Fail, never a silent Pass. */
export function invariantRow(market: MarketRow, vault: bigint | null): InvariantRow {
  return { market: market.address, ...vaultInvariant(market.pairsOutstanding, vault) };
}

/**
 * The invariant check itself, shared by /status and the Trade page's vault chip (P0-7) so both
 * always agree: expected = `pairs × 1,000,000` base units; Pass only on an exact match.
 */
export function vaultInvariant(pairs: bigint, vault: bigint | null): Omit<InvariantRow, "market"> {
  const expected = pairs * BASE_UNITS_PER_PAIR;
  return {
    verdict: vault !== null && vault === expected ? "Pass" : "Fail",
    expected,
    actual: vault,
  };
}

/** What the page learned from a market's events; each field is `null` when not (yet) known. */
export type MarketFacts = {
  /** Block time of `MarketCreated`. */
  readonly createdAt: number | null;
  /** Block time of `MarketSettled`. */
  readonly settledAt: number | null;
  /** Slot of the settle transaction. */
  readonly settleSlot: number | null;
  /** `oracle_slot` from `MarketSettled`. */
  readonly oracleSlot: bigint | null;
};

export const NO_FACTS: MarketFacts = {
  createdAt: null,
  settledAt: null,
  settleSlot: null,
  oracleSlot: null,
};

/** Folds the decoded events of a market's creation and settle transactions into facts. */
export function factsFromEvents(
  events: readonly MeridianEvent[],
  settleSlot: number | null,
): MarketFacts {
  const created = events.find((event) => event.kind === "MarketCreated");
  const settled = events.find((event) => event.kind === "MarketSettled");
  return {
    createdAt: created?.blockTime ?? null,
    settledAt: settled?.blockTime ?? null,
    settleSlot: settled === undefined ? null : settleSlot,
    oracleSlot: settled?.kind === "MarketSettled" ? settled.oracleSlot : null,
  };
}

/** Slots between the oracle's reading and the settle transaction; never negative. */
export function oracleAgeSlots(facts: MarketFacts): bigint | null {
  if (facts.oracleSlot === null || facts.settleSlot === null) return null;
  const age = BigInt(facts.settleSlot) - facts.oracleSlot;
  return age < 0n ? 0n : age;
}

/** Rough whole seconds for a slot count (400 ms slots, rounded down). */
export const slotsToSecs = (slots: bigint): bigint => (slots * SLOT_MS) / 1000n;

const etHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  hourCycle: "h23",
});

/** Unix seconds of `HH:mm` ET on the `YYYYMMDD` trading date (DST-safe, no offsets). */
export function etWallClockToUnix(tradingDate: number, hour: number, minute: number): number {
  const year = Math.floor(tradingDate / 10_000);
  const month = Math.floor(tradingDate / 100) % 100;
  const day = tradingDate % 100;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  // ET is UTC-4 or UTC-5: try both and keep the one whose ET hour matches.
  for (const offsetHours of [4, 5]) {
    const candidate = asUtc + offsetHours * 3600;
    if (Number(etHour.format(new Date(candidate * 1000))) === hour) return candidate;
  }
  throw new RangeError(`no ET wall-clock time ${hour}:${minute} on ${tradingDate}`);
}

export type SettlementState = "Pending" | "On time" | "Late" | "Unknown";

export type MarketStatusRow = {
  readonly market: MarketRow;
  readonly invariant: InvariantRow;
  readonly createdAt: number | null;
  readonly settledAt: number | null;
  readonly settlement: SettlementState;
  /** Seconds after `close_ts` that the settle landed (negative = before close). */
  readonly settleDelaySecs: number | null;
  readonly oracleAgeSlots: bigint | null;
};

export function marketStatusRow(
  market: MarketRow,
  vault: bigint | null,
  facts: MarketFacts,
): MarketStatusRow {
  const delay = facts.settledAt === null ? null : facts.settledAt - Number(market.closeTs);
  const settlement: SettlementState = !market.settled
    ? "Pending"
    : delay === null
      ? "Unknown"
      : delay <= ON_TIME_SETTLE_SECS
        ? "On time"
        : "Late";
  return {
    market,
    invariant: invariantRow(market, vault),
    createdAt: facts.createdAt,
    settledAt: facts.settledAt,
    settlement,
    settleDelaySecs: delay,
    oracleAgeSlots: oracleAgeSlots(facts),
  };
}

export type DayLiveness = {
  readonly tradingDate: number;
  readonly rows: readonly MarketStatusRow[];
  /** 09:00 ET of the day, unix seconds. */
  readonly creationDeadline: number;
  /** Latest known creation time; `null` when none is known. */
  readonly lastCreatedAt: number | null;
  /** `Pass` when every market's creation time is known and at or before 09:00 ET. */
  readonly creation: Verdict;
  readonly createdKnown: number;
  readonly worstSettleDelaySecs: number | null;
  readonly settledCount: number;
  readonly maxOracleAgeSlots: bigint | null;
};

/** Groups rows by trading date, newest day first, with the per-day liveness summary. */
export function buildDays(rows: readonly MarketStatusRow[]): DayLiveness[] {
  const byDate = new Map<number, MarketStatusRow[]>();
  for (const row of rows) {
    byDate.set(row.market.tradingDate, [...(byDate.get(row.market.tradingDate) ?? []), row]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([tradingDate, dayRows]) => {
      const deadline = etWallClockToUnix(
        tradingDate,
        CREATION_DEADLINE_ET.hour,
        CREATION_DEADLINE_ET.minute,
      );
      const created = dayRows.flatMap((row) => (row.createdAt === null ? [] : [row.createdAt]));
      const delays = dayRows.flatMap((row) =>
        row.settleDelaySecs === null ? [] : [row.settleDelaySecs],
      );
      const ages = dayRows.flatMap((row) =>
        row.oracleAgeSlots === null ? [] : [row.oracleAgeSlots],
      );
      const lastCreatedAt = created.length === 0 ? null : Math.max(...created);
      return {
        tradingDate,
        rows: [...dayRows].sort((a, b) =>
          a.market.ticker === b.market.ticker
            ? Number(a.market.strikeCents - b.market.strikeCents)
            : a.market.ticker.localeCompare(b.market.ticker),
        ),
        creationDeadline: deadline,
        lastCreatedAt,
        creation:
          created.length === dayRows.length && lastCreatedAt !== null && lastCreatedAt <= deadline
            ? "Pass"
            : "Fail",
        createdKnown: created.length,
        worstSettleDelaySecs: delays.length === 0 ? null : Math.max(...delays),
        settledCount: dayRows.filter((row) => row.market.settled).length,
        maxOracleAgeSlots: ages.length === 0 ? null : ages.reduce((a, b) => (a > b ? a : b)),
      };
    });
}

const etStamp = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** `2026-03-08 03:00:00 ET` for unix seconds (DST from the platform's IANA data). */
export function formatEtStamp(unixSecs: number): string {
  const parts = etStamp.formatToParts(new Date(unixSecs * 1000));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")} ET`;
}
