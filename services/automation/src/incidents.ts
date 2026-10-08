/**
 * Incident hand-off to the ops agent (`POST /incidents`, architecture.md § Service HTTP
 * contracts). A stub until M3: without `OPS_AGENT_URL` the incident is only logged. Like alerts
 * it never throws and never logs the URL or the token.
 */
import type { HttpPost } from "./alerts";
import { describeError, type Logger } from "./log";

export interface Incident {
  readonly kind: "settlement_failed";
  /** ET trading date, `YYYY-MM-DD`. */
  readonly tradingDate: string;
  readonly tickers: readonly string[];
  readonly reasons: readonly string[];
  readonly at: string;
}

export interface IncidentClient {
  /** Resolves to whether the ops agent accepted it. Never rejects. */
  post(incident: Incident): Promise<boolean>;
}

export function createIncidentClient(deps: {
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly post: HttpPost;
  readonly log: Logger;
  readonly timeoutMs?: number;
}): IncidentClient {
  return {
    async post(incident) {
      if (deps.url === undefined || deps.url === "") {
        deps.log("warn", "incident_not_sent", {
          reason: "OPS_AGENT_URL is not configured (ops-agent arrives in M3)",
          tickers: incident.tickers,
        });
        return false;
      }
      try {
        const response = await deps.post(`${deps.url.replace(/\/+$/, "")}/incidents`, {
          headers: {
            "Content-Type": "application/json",
            ...(deps.token === undefined ? {} : { Authorization: `Bearer ${deps.token}` }),
          },
          body: JSON.stringify(incident),
          signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
        });
        if (response.status < 200 || response.status >= 300) {
          deps.log("warn", "incident_post_failed", { status: response.status });
          return false;
        }
        return true;
      } catch (error) {
        deps.log("warn", "incident_post_failed", { error: describeError(error) });
        return false;
      }
    },
  };
}
