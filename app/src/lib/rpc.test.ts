import { describe, expect, it, vi } from "vitest";

import { backoffMs, dedupe, sharedConnection, withRateLimitRetry } from "./rpc";

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response("{}", { status, headers });

describe("withRateLimitRetry", () => {
  it("retries 429 with jittered backoff, then returns the success", async () => {
    const inner = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));
    const sleeps: number[] = [];
    const wrapped = withRateLimitRetry(inner, {
      baseMs: 100,
      random: () => 0.5,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect((await wrapped("http://rpc", {})).status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([50, 100]);
  });

  it("gives up after the retry budget and honours Retry-After", async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(res(429, { "retry-after": "1" }));
    const sleeps: number[] = [];
    const wrapped = withRateLimitRetry(inner, {
      retries: 2,
      random: () => 0,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect((await wrapped("http://rpc", {})).status).toBe(429);
    expect(inner).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("does not retry other errors", async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(res(500));
    expect((await withRateLimitRetry(inner)("http://rpc", {})).status).toBe(500);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe("backoffMs", () => {
  it("caps the exponential window", () => {
    expect(backoffMs(10, 400, 8000, () => 1)).toBe(8000);
  });
});

describe("dedupe", () => {
  it("shares in-flight calls and caches within the TTL, but not failures", async () => {
    let t = 0;
    const load = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue(1);
    const get = dedupe(load, 1000, () => t);
    await expect(get()).rejects.toThrow("429");
    const [a, b] = await Promise.all([get(), get()]);
    expect([a, b]).toEqual([1, 1]);
    expect(load).toHaveBeenCalledTimes(2);
    t = 2000;
    await get();
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe("sharedConnection", () => {
  it("returns one connection per URL", () => {
    expect(sharedConnection("http://a.test")).toBe(sharedConnection("http://a.test"));
    expect(sharedConnection("http://a.test")).not.toBe(sharedConnection("http://b.test"));
  });
});
