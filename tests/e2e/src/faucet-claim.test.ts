import { describe, expect, it } from "vitest";

import { claimFromFaucet, type FetchLike } from "./faucet-claim";

const reply =
  (status: number, body: string): FetchLike =>
  () =>
    Promise.resolve({ status, text: () => Promise.resolve(body) });

describe("claimFromFaucet", () => {
  it("posts the wallet to /api/faucet and returns the signature", async () => {
    let seen: { url: string; body: string } | undefined;
    const fetchImpl: FetchLike = (url, init) => {
      seen = { url, body: init.body };
      return reply(200, JSON.stringify({ signature: "SIG", amount_base_units: "1" }))(url, init);
    };
    expect(await claimFromFaucet(fetchImpl, "http://localhost:3000/", "W")).toEqual({
      kind: "claimed",
      signature: "SIG",
    });
    expect(seen).toEqual({ url: "http://localhost:3000/api/faucet", body: '{"wallet":"W"}' });
  });

  it("treats 429 as already claimed", async () => {
    expect(await claimFromFaucet(reply(429, '{"error":"wait"}'), "http://x", "W")).toEqual({
      kind: "already-claimed",
    });
  });

  it("fails loudly on other statuses, malformed bodies and unreachable servers, without the URL", async () => {
    await expect(claimFromFaucet(reply(503, '{"error":"low"}'), "http://x", "W")).rejects.toThrow(
      /HTTP 503: low/,
    );
    await expect(claimFromFaucet(reply(500, "<html>"), "http://x", "W")).rejects.toThrow(
      /HTTP 500/,
    );
    await expect(claimFromFaucet(reply(200, "{}"), "http://x", "W")).rejects.toThrow(/signature/);
    const down: FetchLike = () =>
      Promise.reject(new Error("connect ECONNREFUSED http://secret-host"));
    const error = await claimFromFaucet(down, "http://secret-host", "W").catch((e: unknown) => e);
    expect(String(error)).toMatch(/unreachable/);
    expect(String(error)).not.toContain("secret-host");
  });
});
