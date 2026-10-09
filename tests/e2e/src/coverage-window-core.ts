/**
 * Book-coverage window (M3-09, plan M3 exit "≥ 95% of open strikes two-sided over 30 min"). The
 * pure part: what counts as two-sided, one sample's coverage, the pooled summary of a window with
 * the per-strike shortfalls, the sampling loop with an injected clock, and the `docs/log.md` entry.
 * Coverage is integer basis points (1 bp = 0.01%), never a float; nothing here reads a clock or
 * the network, so a recorded sample stream reproduces the summary exactly.
 */
import type { BookQuotes } from "@meridian/client";

/** 95.00% as basis points: the requirements.md "Book coverage" target. */
export const TARGET_BPS = 9_500;
export const DEFAULT_INTERVAL_SECS = 30;
export const DEFAULT_DURATION_SECS = 30 * 60;
/** More than this share of failed reads (in tenths of a percent) and no claim can be made. */
const MAX_FAILED_PER_MILLE = 100;

/** One open strike in one sample; `quotes` is `null` when its book could not be read. */
export type StrikeSample = {
  /** Market address (base58). */
  readonly market: string;
  /** Human label, for example `META $680`. */
  readonly label: string;
  readonly quotes: BookQuotes | null;
};

/** One read of every open strike at `at` (unix seconds), or a failed read. */
export type Sample =
  | { readonly ok: true; readonly at: number; readonly strikes: readonly StrikeSample[] }
  | { readonly ok: false; readonly at: number; readonly error: string };

/** A strike is two-sided when the book has both a best bid and a best ask. */
export function isTwoSided(quotes: BookQuotes | null): boolean {
  return quotes !== null && quotes.yesBid !== null && quotes.yesAsk !== null;
}

/** `floor(part × 10,000 / whole)` in integers; `null` for an empty whole (never 100%). */
export function ratioBps(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Number((BigInt(part) * 10_000n) / BigInt(whole));
}

/** Basis points as `95.00%`. */
export function formatBps(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;
}

/** Coverage of one sample: share of its open strikes that are two-sided. */
export function sampleCoverageBps(strikes: readonly StrikeSample[]): number | null {
  return ratioBps(strikes.filter((strike) => isTwoSided(strike.quotes)).length, strikes.length);
}

export type StrikeSummary = {
  readonly label: string;
  readonly market: string;
  /** Samples in which the strike was open. */
  readonly samples: number;
  readonly twoSided: number;
  readonly bps: number;
};

export type Summary = {
  readonly samples: number;
  readonly failedSamples: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Strike-samples: Σ over samples of the open strikes, and of those two-sided. */
  readonly openStrikeSamples: number;
  readonly twoSidedStrikeSamples: number;
  /** Pooled coverage; `null` when no open strike was ever sampled. */
  readonly pooledBps: number | null;
  readonly minSampleBps: number | null;
  readonly perStrike: readonly StrikeSummary[];
  /** Strikes below the target over the window, worst first (the diagnosis list). */
  readonly shortfalls: readonly StrikeSummary[];
  /** True only with a trustworthy window: ≥ 95% pooled, some strikes sampled, few failed reads. */
  readonly passes: boolean;
  /** Why `passes` is false, in words; empty when it passes. */
  readonly reasons: readonly string[];
};

/** Pools the window: the requirement is the share of (strike, sample) pairs that were two-sided. */
export function summarize(samples: readonly Sample[]): Summary {
  const good = samples.flatMap((sample) => (sample.ok ? [sample] : []));
  const failedSamples = samples.length - good.length;
  const perStrike = new Map<string, { label: string; samples: number; twoSided: number }>();
  let open = 0;
  let two = 0;
  let min: number | null = null;
  for (const sample of good) {
    for (const strike of sample.strikes) {
      const entry = perStrike.get(strike.market) ?? {
        label: strike.label,
        samples: 0,
        twoSided: 0,
      };
      entry.samples += 1;
      open += 1;
      if (isTwoSided(strike.quotes)) {
        entry.twoSided += 1;
        two += 1;
      }
      perStrike.set(strike.market, entry);
    }
    const bps = sampleCoverageBps(sample.strikes);
    if (bps !== null && (min === null || bps < min)) min = bps;
  }
  const strikes: StrikeSummary[] = [...perStrike.entries()]
    .map(([market, entry]) => ({
      market,
      label: entry.label,
      samples: entry.samples,
      twoSided: entry.twoSided,
      bps: ratioBps(entry.twoSided, entry.samples) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const pooledBps = ratioBps(two, open);
  const reasons: string[] = [];
  if (samples.length === 0) reasons.push("no samples were taken");
  if (open === 0) reasons.push("no open strike was ever sampled");
  if (samples.length > 0 && failedSamples * 1000 > samples.length * MAX_FAILED_PER_MILLE) {
    reasons.push(`${failedSamples} of ${samples.length} reads failed (more than 10%)`);
  }
  if (pooledBps !== null && pooledBps < TARGET_BPS) {
    reasons.push(`pooled coverage ${formatBps(pooledBps)} is below ${formatBps(TARGET_BPS)}`);
  }
  return {
    samples: samples.length,
    failedSamples,
    startedAt: samples[0]?.at ?? null,
    endedAt: samples[samples.length - 1]?.at ?? null,
    openStrikeSamples: open,
    twoSidedStrikeSamples: two,
    pooledBps,
    minSampleBps: min,
    perStrike: strikes,
    shortfalls: strikes.filter((s) => s.bps < TARGET_BPS).sort((a, b) => a.bps - b.bps),
    passes: reasons.length === 0,
    reasons,
  };
}

export type Collector = {
  /** Reads every open strike now. May throw; the failure is recorded, not hidden. */
  sample(): Promise<readonly StrikeSample[]>;
  /** Unix seconds now. */
  now(): number;
  /** Waits `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
  intervalSecs?: number;
  durationSecs?: number;
  /** Called after every sample, for progress output. */
  onSample?(sample: Sample): void;
};

/**
 * Samples on a fixed schedule: at the start and every `intervalSecs` until `durationSecs` has
 * elapsed, so a 30 min window at 30 s holds 61 samples. The schedule is anchored to the start, so
 * a slow read does not push every later sample back; a read that overruns skips to the next slot.
 */
export async function collect(collector: Collector): Promise<Sample[]> {
  const interval = collector.intervalSecs ?? DEFAULT_INTERVAL_SECS;
  const duration = collector.durationSecs ?? DEFAULT_DURATION_SECS;
  if (!Number.isInteger(interval) || interval < 1)
    throw new Error("interval must be whole seconds");
  if (!Number.isInteger(duration) || duration < 0)
    throw new Error("duration must be whole seconds");
  const start = collector.now();
  const samples: Sample[] = [];
  for (let slot = 0; slot * interval <= duration; slot += 1) {
    const due = start + slot * interval;
    const wait = due - collector.now();
    if (wait > 0) await collector.sleep(wait * 1000);
    else if (slot > 0 && collector.now() >= due + interval) continue; // overran: next slot
    const at = collector.now();
    let sample: Sample;
    try {
      sample = { ok: true, at, strikes: await collector.sample() };
    } catch (error) {
      sample = { ok: false, at, error: error instanceof Error ? error.message : String(error) };
    }
    samples.push(sample);
    collector.onSample?.(sample);
  }
  return samples;
}

/** The `docs/log.md` entry for a finished window (public data only). */
export function renderLogEntry(
  summary: Summary,
  context: {
    readonly who: string;
    readonly date: string;
    readonly etWindow: string;
    readonly intervalSecs: number;
  },
): string {
  const verdict = summary.passes ? "PASS" : "FAIL";
  const pooled = summary.pooledBps === null ? "n/a" : formatBps(summary.pooledBps);
  const lines = [
    `### Book coverage window · ${context.date} · ${verdict}`,
    `- Who: ${context.who}. Window (ET): ${context.etWindow}. Sampled every ${context.intervalSecs} s: ${summary.samples} samples, ${summary.failedSamples} failed reads.`,
    `- Pooled two-sided coverage: **${pooled}** (${summary.twoSidedStrikeSamples} of ${summary.openStrikeSamples} strike-samples; target ${formatBps(TARGET_BPS)}); worst single sample ${summary.minSampleBps === null ? "n/a" : formatBps(summary.minSampleBps)}.`,
  ];
  if (summary.reasons.length > 0) lines.push(`- Not passing: ${summary.reasons.join("; ")}.`);
  if (summary.shortfalls.length > 0) {
    lines.push(
      "- Strikes below target (open a fix ticket for each cause): " +
        summary.shortfalls.map((s) => `${s.label} ${formatBps(s.bps)}`).join(", ") +
        ".",
    );
  }
  return `${lines.join("\n")}\n`;
}
