import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { fetchOpenTimes, OPEN_TIMES_PATH, openTimeOf, openTimesSchema } from "./open-times-core";

const MARKET = "Mkt1111111111111111111111111111111111111111";
const BODY = {
  ready: true,
  as_of: "2026-10-09T12:05:00.000Z",
  markets: [{ market: MARKET, opened_at: 1_791_288_000, signature: "sig1" }],
};

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("fetchOpenTimes", () => {
  it("reads the proxy once, no-store, and indexes times by market", async () => {
    const fetcher = vi.fn(respond(200, BODY));
    expect(await fetchOpenTimes(fetcher)).toEqual({
      ready: true,
      byMarket: { [MARKET]: 1_791_288_000 },
    });
    expect(fetcher).toHaveBeenCalledWith(OPEN_TIMES_PATH, { cache: "no-store" });
  });

  it("throws plain words on 503 and other error statuses, never the body", async () => {
    await expect(fetchOpenTimes(respond(503, { error: "x" }))).rejects.toThrow(
      "open times are not configured for this app",
    );
    await expect(fetchOpenTimes(respond(502, { error: "secret" }))).rejects.toThrow(
      "open times could not be read (502)",
    );
  });

  it("throws on a body that is not JSON or not the documented shape", async () => {
    await expect(
      fetchOpenTimes(() => Promise.resolve(new Response("<html>", { status: 200 }))),
    ).rejects.toThrow("unexpected shape");
    await expect(
      fetchOpenTimes(respond(200, { ...BODY, markets: [{ market: MARKET, opened_at: "9am" }] })),
    ).rejects.toThrow("unexpected shape");
  });

  it("rejects when the network fails", async () => {
    await expect(fetchOpenTimes(() => Promise.reject(new Error("offline")))).rejects.toThrow(
      "offline",
    );
  });
});

describe("openTimeOf", () => {
  it("is the time when known, a dash (null) when a ready index has none, unavailable while rebuilding", () => {
    expect(openTimeOf({ ready: true, byMarket: { [MARKET]: 5 } }, MARKET)).toBe(5);
    expect(openTimeOf({ ready: false, byMarket: { [MARKET]: 5 } }, MARKET)).toBe(5);
    expect(openTimeOf({ ready: true, byMarket: {} }, MARKET)).toBeNull();
    expect(openTimeOf({ ready: false, byMarket: {} }, MARKET)).toBe("unavailable");
  });
});

describe("openTimesSchema (property)", () => {
  it("accepts only positive integer unix seconds", () => {
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.integer(), fc.string()), (openedAt) => {
        const parsed = openTimesSchema.safeParse({
          ...BODY,
          markets: [{ market: MARKET, opened_at: openedAt, signature: "s" }],
        });
        const valid =
          typeof openedAt === "number" && Number.isSafeInteger(openedAt) && openedAt > 0;
        expect(parsed.success).toBe(valid);
      }),
    );
  });
});
