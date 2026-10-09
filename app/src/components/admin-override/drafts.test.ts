import { describe, expect, it, vi } from "vitest";

import { draftSchema, draftsSchema, fetchDrafts, DRAFTS_PATH } from "./drafts";
import { draft, MARKET_ADDRESS } from "./test-support";

describe("draftSchema", () => {
  it("accepts the documented shape", () => {
    expect(draftSchema.parse(draft())).toEqual(draft());
  });

  it("drops fields it does not know", () => {
    expect(draftSchema.parse({ ...draft(), api_key: "k", fallback: true })).toEqual(draft());
  });

  it.each([
    ["a non-integer price", { proposed_price_cents: 1.5 }],
    ["a negative price", { proposed_price_cents: -1 }],
    ["a price beyond a safe integer", { proposed_price_cents: 2 ** 53 }],
    ["a market that is not base58", { market: "not-an-address" }],
    ["a market that is a URL", { market: "https://evil.test/x" }],
    ["no sources", { sources: [] }],
    [
      "a source with a float close",
      { sources: [{ name: "t", close: 1.5, as_of: "2026-10-08T20:05:00Z" }] },
    ],
    ["a source with a bad time", { sources: [{ name: "t", close: 1, as_of: "yesterday" }] }],
    ["a negative spread", { spread_bps: -1 }],
    ["an empty incident id", { incident_id: "" }],
  ])("rejects %s", (_name, patch) => {
    expect(draftSchema.safeParse({ ...draft(), ...patch }).success).toBe(false);
  });

  it("accepts a source time with an offset", () => {
    const d = draft({ sources: [{ name: "t", close: 1, as_of: "2026-10-08T16:05:00-04:00" }] });
    expect(draftSchema.safeParse(d).success).toBe(true);
    expect(MARKET_ADDRESS.length).toBeGreaterThan(30);
  });

  it("limits the list size", () => {
    expect(draftsSchema.safeParse(Array.from({ length: 201 }, () => draft())).success).toBe(false);
  });
});

describe("fetchDrafts", () => {
  const reply = (status: number, body: unknown) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("reads the proxy path with no caching", async () => {
    const fetcher = reply(200, [draft()]);
    expect(await fetchDrafts(fetcher)).toEqual([draft()]);
    expect(fetcher).toHaveBeenCalledWith(DRAFTS_PATH, { cache: "no-store" });
  });

  it("says plainly when the agent is not configured, and when it cannot be reached", async () => {
    await expect(fetchDrafts(reply(503, { error: "x" }))).rejects.toThrow(/not configured/);
    await expect(fetchDrafts(reply(502, { error: "x" }))).rejects.toThrow(
      /could not be reached \(502\)/,
    );
  });

  it("rejects a reply in an unexpected shape without echoing it", async () => {
    await expect(fetchDrafts(reply(200, [{ secret: "leak" }]))).rejects.toThrow(
      "the ops agent returned drafts in an unexpected shape",
    );
  });
});
