/**
 * Alerts (architecture.md § External integrations): a JSON POST to `ALERT_WEBHOOK_URL`
 * (Discord/Slack-compatible), always logged locally, never blocking a job and never throwing.
 * The webhook URL is a secret: it is not logged and failure messages go through `describeError`.
 */
import { describeError, type Logger } from "./log";

/** The subset of `fetch` an alert needs; production passes a thin wrapper over `globalThis.fetch`. */
export type HttpPost = (
  url: string,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly status: number }>;

export interface Alert {
  /** Machine-readable class, e.g. `morning_failed`. */
  readonly kind: string;
  /** One human-readable line. */
  readonly summary: string;
  readonly details?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

export interface Alerter {
  /** Delivers the alert; resolves to whether the webhook accepted it. Never rejects. */
  send(alert: Alert): Promise<boolean>;
}

export interface AlerterDeps {
  /** Absent: alerts are only logged. */
  readonly webhookUrl?: string | undefined;
  readonly post: HttpPost;
  readonly log: Logger;
  readonly timeoutMs?: number;
}

export const DEFAULT_ALERT_TIMEOUT_MS = 10_000;

export function createAlerter(deps: AlerterDeps): Alerter {
  return {
    async send(alert) {
      deps.log("error", "alert", {
        kind: alert.kind,
        summary: alert.summary,
        ...(alert.details === undefined ? {} : { details: alert.details }),
      });
      if (deps.webhookUrl === undefined || deps.webhookUrl === "") {
        return false;
      }
      const text = `[meridian] ${alert.kind}: ${alert.summary}`;
      try {
        const response = await deps.post(deps.webhookUrl, {
          headers: { "Content-Type": "application/json" },
          // `text` is Slack's field, `content` Discord's; both carry the same line.
          body: JSON.stringify({ text, content: text, ...alert }),
          signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS),
        });
        if (response.status < 200 || response.status >= 300) {
          deps.log("warn", "alert_delivery_failed", { kind: alert.kind, status: response.status });
          return false;
        }
        return true;
      } catch (error) {
        deps.log("warn", "alert_delivery_failed", {
          kind: alert.kind,
          error: describeError(error),
        });
        return false;
      }
    },
  };
}
