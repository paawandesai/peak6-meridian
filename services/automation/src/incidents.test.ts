import { describe, expect, it } from "vitest";

import type { HttpPost } from "./alerts";
import { createIncidentClient, type Incident } from "./incidents";
import { recordingLogger } from "./testing";

const incident: Incident = {
  kind: "settlement_failed",
  tradingDate: "2026-10-06",
  tickers: ["META"],
  reasons: ["missing_bar"],
  at: "2026-10-06T20:20:00.000Z",
};

describe("createIncidentClient", () => {
  it("POSTs to /incidents with the service bearer token", async () => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const post: HttpPost = (url, init) => {
      calls.push({ url, headers: { ...init.headers }, body: JSON.parse(init.body) });
      return Promise.resolve({ status: 202 });
    };
    const logger = recordingLogger();
    const client = createIncidentClient({
      url: "http://ops.internal:4200/",
      token: "tok-123456",
      post,
      log: logger.log,
    });
    expect(await client.post(incident)).toBe(true);
    expect(calls).toEqual([
      {
        url: "http://ops.internal:4200/incidents",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok-123456" },
        body: incident,
      },
    ]);
  });

  it("is a logging stub without OPS_AGENT_URL", async () => {
    const logger = recordingLogger();
    const post: HttpPost = () => Promise.reject(new Error("must not be called"));
    expect(await createIncidentClient({ post, log: logger.log }).post(incident)).toBe(false);
    expect(logger.lines.map((l) => l.event)).toEqual(["incident_not_sent"]);
  });

  it("never throws and never logs the URL or token when delivery fails", async () => {
    const logger = recordingLogger();
    const failing = createIncidentClient({
      url: "https://ops.example/?key=SECRET",
      token: "TOKENVALUE",
      post: () => Promise.reject(new Error("connect ECONNREFUSED https://ops.example/?key=SECRET")),
      log: logger.log,
    });
    expect(await failing.post(incident)).toBe(false);
    const rejecting = createIncidentClient({
      url: "https://ops.example",
      post: () => Promise.resolve({ status: 500 }),
      log: logger.log,
    });
    expect(await rejecting.post(incident)).toBe(false);
    expect(logger.lines.filter((l) => l.event === "incident_post_failed")).toHaveLength(2);
    expect(JSON.stringify(logger.lines)).not.toMatch(/SECRET|TOKENVALUE/);
  });
});
