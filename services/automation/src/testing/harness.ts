/** Test doubles shared by the job and service tests: a fake clock, an in-memory chain and logs. */
import type { Keypair } from "@solana/web3.js";

import type { Alert, Alerter } from "../alerts";
import { SETTLEMENT_CRON } from "../jobs/settle";
import type { JobSpec } from "../scheduler";
import type { MarketOps, PlannedMarket } from "../cli/createMarkets";
import type { Logger } from "../log";

/** A clock whose `sleep` advances time instantly. */
export class FakeClock {
  readonly sleeps: number[] = [];
  private current: number;

  constructor(start: Date) {
    this.current = start.getTime();
  }

  now = (): Date => new Date(this.current);

  sleep = (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.current += ms;
    return Promise.resolve();
  };

  get ms(): number {
    return this.current;
  }
}

export function marketId(planned: PlannedMarket): string {
  return `${planned.key.symbol}:${String(planned.key.tradingDate)}:${planned.key.strikeCents.toString()}`;
}

/** An in-memory chain; `failCreates` makes the next N creations throw. */
export class FakeChain implements MarketOps {
  readonly markets = new Map<string, PlannedMarket>();
  readonly createCalls: PlannedMarket[] = [];
  failCreates: { remaining: number; message: string } | null = null;

  exists = (planned: PlannedMarket): Promise<boolean> =>
    Promise.resolve(this.markets.has(marketId(planned)));

  create = (planned: PlannedMarket): Promise<string> => {
    if (this.failCreates !== null && this.failCreates.remaining > 0) {
      this.failCreates.remaining -= 1;
      return Promise.reject(new Error(this.failCreates.message));
    }
    this.createCalls.push(planned);
    this.markets.set(marketId(planned), planned);
    return Promise.resolve(`sig-${String(this.createCalls.length)}`);
  };
}

/** Records every alert instead of sending it. */
export class RecordingAlerter implements Alerter {
  readonly alerts: Alert[] = [];

  send = (alert: Alert): Promise<boolean> => {
    this.alerts.push(alert);
    return Promise.resolve(true);
  };
}

export interface LogLine {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

export function recordingLogger(): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    log: (level, event, fields) => {
      lines.push({ level, event, fields });
    },
  };
}

/** A settlement job spec that does nothing, bound to `signer`, for service-level tests. */
export function noopSettlementJob(signer: Keypair): JobSpec {
  return {
    name: "settlement",
    cron: SETTLEMENT_CRON,
    signer: signer.publicKey.toBase58(),
    run: () => Promise.resolve(),
  };
}
