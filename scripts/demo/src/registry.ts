/**
 * The committed demo-session registry (`deployments/demo-sessions.json`), validated with the
 * schema the app's DEMO banner imports from `@meridian/client`.
 */
import {
  type DemoSession,
  type DemoSessions,
  demoSessionsSchema,
  findDemoSession,
  type IsoDate,
} from "@meridian/client";
import { z } from "zod";

import { formatEt } from "./dates";

/** Reads the registry; a missing file (`text === null`) is an empty registry. */
export function parseRegistry(text: string | null, label: string): DemoSessions {
  if (text === null) {
    return { sessions: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const parsed = demoSessionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${label}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** The registry as written to disk: sessions by trading date, two-space JSON, final newline. */
export function serializeRegistry(registry: DemoSessions): string {
  const sessions = [...registry.sessions].sort((a, b) =>
    a.tradingDate.localeCompare(b.tradingDate),
  );
  return `${JSON.stringify(demoSessionsSchema.parse({ programId: registry.programId, sessions }), null, 2)}\n`;
}

/**
 * Refuses to reuse a registered trading date for a different simulated session or close: its
 * markets already exist on chain with that session's strikes and close.
 */
export function assertCompatible(
  registry: DemoSessions,
  tradingDate: IsoDate,
  asOf: IsoDate,
  closeTs: number,
): void {
  const existing = findDemoSession(registry, tradingDate);
  if (existing === undefined) {
    return;
  }
  if (existing.asOf !== asOf || existing.closeTs !== closeTs) {
    throw new Error(
      `TRADING_DATE ${tradingDate} is already a demo of ${existing.asOf} closing ` +
        `${formatEt(existing.closeTs)}; re-run with those values or pick another TRADING_DATE`,
    );
  }
}

/**
 * Adds or updates the session of `next.tradingDate`: keeps the first `createdAt`, unions the
 * tickers and strikes, and merges known closes (a known close is never dropped).
 */
export function upsertSession(registry: DemoSessions, next: DemoSession): DemoSessions {
  const existing = findDemoSession(registry, next.tradingDate);
  const others = registry.sessions.filter((s) => s.tradingDate !== next.tradingDate);
  if (existing === undefined) {
    return { ...registry, sessions: [...others, next] };
  }
  const strikesByTicker: Record<string, number[]> = { ...existing.strikesByTicker };
  for (const [ticker, strikes] of Object.entries(next.strikesByTicker)) {
    strikesByTicker[ticker] = [...new Set([...(strikesByTicker[ticker] ?? []), ...strikes])].sort(
      (a, b) => a - b,
    );
  }
  const merged: DemoSession = {
    ...existing,
    ...next,
    createdAt: existing.createdAt,
    tickers: [...new Set([...existing.tickers, ...next.tickers])],
    strikesByTicker,
    asOfCloseCentsByTicker: { ...existing.asOfCloseCentsByTicker, ...next.asOfCloseCentsByTicker },
  };
  const prevCloses = { ...existing.prevCloseCentsByTicker, ...next.prevCloseCentsByTicker };
  if (Object.keys(prevCloses).length > 0) {
    merged.prevCloseCentsByTicker = prevCloses;
  }
  return { ...registry, sessions: [...others, merged] };
}

/** Records AS_OF closes learned later (demo-settle) on an existing session. */
export function withAsOfCloses(
  registry: DemoSessions,
  tradingDate: IsoDate,
  closes: Readonly<Record<string, number>>,
): DemoSessions {
  return {
    ...registry,
    sessions: registry.sessions.map((session) =>
      session.tradingDate === tradingDate
        ? {
            ...session,
            asOfCloseCentsByTicker: { ...session.asOfCloseCentsByTicker, ...closes },
          }
        : session,
    ),
  };
}

/**
 * Stamps the program the sessions' markets live in (AB-17: a deployment record names its program).
 * Refuses a registry that already names a different program: its sessions belong to that one.
 */
export function withProgramId(registry: DemoSessions, programId: string): DemoSessions {
  if (registry.programId !== undefined && registry.programId !== programId) {
    throw new Error(
      `the demo-session registry belongs to program ${registry.programId}, not ${programId}`,
    );
  }
  return { ...registry, programId };
}
