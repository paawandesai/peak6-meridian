import { describe, expect, it } from "vitest";

import { createAlerter, type HttpPost } from "./alerts";
import { recordingLogger } from "./testing/harness";

const WEBHOOK = "https://hooks.example/services/T000/B000/SECRETSECRET";

describe("createAlerter", () => {
  it("POSTs a Slack/Discord-compatible JSON body and logs the alert locally", async () => {
    const sent: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const post: HttpPost = (url, init) => {
      sent.push({ url, body: JSON.parse(init.body), headers: { ...init.headers } });
      return Promise.resolve({ status: 204 });
    };
    const logger = recordingLogger();
    const delivered = await createAlerter({ webhookUrl: WEBHOOK, post, log: logger.log }).send({
      kind: "morning_failed",
      summary: "no markets for META",
      details: { failedTickers: ["META"] },
    });
    expect(delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(WEBHOOK);
    expect(sent[0]?.headers["Content-Type"]).toBe("application/json");
    expect(sent[0]?.body).toMatchObject({
      text: "[meridian] morning_failed: no markets for META",
      content: "[meridian] morning_failed: no markets for META",
      kind: "morning_failed",
      details: { failedTickers: ["META"] },
    });
    expect(logger.lines.map((l) => l.event)).toEqual(["alert"]);
    expect(JSON.stringify(logger.lines)).not.toContain("SECRETSECRET");
  });

  it("only logs when no webhook is configured", async () => {
    const logger = recordingLogger();
    const post: HttpPost = () => Promise.reject(new Error("must not be called"));
    for (const webhookUrl of [undefined, ""]) {
      expect(
        await createAlerter({ webhookUrl, post, log: logger.log }).send({
          kind: "k",
          summary: "s",
        }),
      ).toBe(false);
    }
    expect(logger.lines.map((l) => l.event)).toEqual(["alert", "alert"]);
  });

  it("never throws and never leaks the webhook URL when delivery fails", async () => {
    const logger = recordingLogger();
    const throwing = createAlerter({
      webhookUrl: WEBHOOK,
      post: () => Promise.reject(new Error(`connect ECONNREFUSED ${WEBHOOK}`)),
      log: logger.log,
    });
    expect(await throwing.send({ kind: "k", summary: "s" })).toBe(false);
    const rejecting = createAlerter({
      webhookUrl: WEBHOOK,
      post: () => Promise.resolve({ status: 500 }),
      log: logger.log,
    });
    expect(await rejecting.send({ kind: "k", summary: "s" })).toBe(false);
    const events = logger.lines.map((l) => l.event);
    expect(events.filter((e) => e === "alert_delivery_failed")).toHaveLength(2);
    expect(JSON.stringify(logger.lines)).not.toContain("SECRETSECRET");
  });
});
