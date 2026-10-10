import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { bearerMatches, createHealthServer } from "./server";

const TOKEN = "local-dev-token";
const servers: { close(): void }[] = [];

async function start(): Promise<string> {
  const server = createHealthServer({
    token: TOKEN,
    health: () => ({ service: "automation", status: "ok" }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

describe("GET /health", () => {
  it("rejects a missing bearer token (AC4)", async () => {
    const response = await fetch(`${await start()}/health`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects an invalid token, another scheme and an empty bearer (AC4)", async () => {
    const base = await start();
    for (const authorization of [
      "Bearer wrong-token",
      `Basic ${TOKEN}`,
      "Bearer ",
      TOKEN,
      `bearer ${TOKEN}`,
    ]) {
      const response = await fetch(`${base}/health`, { headers: { authorization } });
      expect(response.status, authorization).toBe(401);
    }
  });

  it("returns the health report to a valid token", async () => {
    const base = await start();
    const response = await fetch(`${base}/health?verbose=1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ service: "automation", status: "ok" });
  });

  it("answers 405 to other methods and 404 elsewhere, before any auth detail leaks", async () => {
    const base = await start();
    const post = await fetch(`${base}/health`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(404);
  });
});

describe("GET /markets (P1-4)", () => {
  async function startWith(markets?: () => Promise<unknown>): Promise<string> {
    const server = createHealthServer({
      token: TOKEN,
      health: () => ({ service: "automation", status: "ok" }),
      ...(markets === undefined ? {} : { markets }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  it("returns the index body to a valid token", async () => {
    const body = {
      ready: true,
      as_of: null,
      markets: [{ market: "M", opened_at: 1, signature: "s" }],
    };
    const base = await startWith(() => Promise.resolve(body));
    const response = await fetch(`${base}/markets`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
  });

  it("requires the bearer token and GET", async () => {
    let calls = 0;
    const base = await startWith(() => {
      calls += 1;
      return Promise.resolve({});
    });
    expect((await fetch(`${base}/markets`)).status).toBe(401);
    expect(
      (await fetch(`${base}/markets`, { headers: { authorization: "Bearer wrong-token" } })).status,
    ).toBe(401);
    const post = await fetch(`${base}/markets`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(405);
    expect(calls).toBe(0);
  });

  it("answers 500 without detail when the handler fails", async () => {
    const base = await startWith(() => Promise.reject(new Error("secret detail")));
    const response = await fetch(`${base}/markets`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });
  });

  it("is 404 when the service has no index, and prototype keys never route", async () => {
    const base = await startWith();
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    expect((await fetch(`${base}/markets`, auth)).status).toBe(404);
    expect((await fetch(`${base}/constructor`, auth)).status).toBe(404);
    expect((await fetch(`${base}/__proto__`, auth)).status).toBe(404);
  });
});

describe("bearerMatches", () => {
  it("compares in constant time regardless of length", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches("Bearer x", TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });
});
