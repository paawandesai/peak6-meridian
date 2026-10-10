// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "svc-token-do-not-leak";
const VALUE = {
  market: "Mkt1111111111111111111111111111111111111111",
  ticker: "NVDA",
  strike_cents: 18_000,
  fair_cents: 58,
  sigma: 0.32,
  spot: "181.42",
  as_of: "2026-10-08T19:59:58Z",
  stale: false,
};

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
let server: Server;
let seen: { path: string; auth: string | undefined }[] = [];

/** A mocked quant service speaking the documented contract. */
async function startQuant(handler: Handler): Promise<string> {
  seen = [];
  server = createServer((request, response) => {
    seen.push({ path: request.url ?? "", auth: request.headers.authorization });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

const quant =
  (body: unknown): Handler =>
  (request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(response, 401, {});
    json(response, 200, body);
  };

async function route() {
  vi.resetModules();
  return import("./route");
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
});

describe("GET /api/fair-values", () => {
  it("sends the server-side bearer, returns the values and never the token", async () => {
    const url = await startQuant(quant([VALUE]));
    vi.stubEnv("QUANT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const response = await (await route()).GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual([VALUE]);
    expect(text).not.toContain(TOKEN);
    expect(seen).toEqual([{ path: "/fair-values", auth: `Bearer ${TOKEN}` }]);
  });

  it("returns only the documented fields", async () => {
    const url = await startQuant(quant([{ ...VALUE, api_key: "k", extra: 1 }]));
    vi.stubEnv("QUANT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const text = await (await (await route()).GET()).text();
    expect(text).not.toContain("api_key");
    expect(text).not.toContain("extra");
  });

  it("is 503 when the URL or token is missing or the URL is not http(s)", async () => {
    for (const env of [
      { QUANT_URL: "", SERVICE_TOKEN: TOKEN },
      { QUANT_URL: "http://127.0.0.1:1", SERVICE_TOKEN: "" },
      { QUANT_URL: "nope", SERVICE_TOKEN: TOKEN },
      { QUANT_URL: "file:///etc/passwd", SERVICE_TOKEN: TOKEN },
    ]) {
      vi.stubEnv("QUANT_URL", env.QUANT_URL);
      vi.stubEnv("SERVICE_TOKEN", env.SERVICE_TOKEN);
      const response = await (await route()).GET();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(TOKEN);
    }
  });

  it("is 502 without leaking when the service rejects the token", async () => {
    const url = await startQuant(quant([VALUE]));
    vi.stubEnv("QUANT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", "wrong-token");
    const response = await (await route()).GET();
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("answered 401");
    expect(text).not.toContain("wrong-token");
  });

  it("is 502 when the service is down", async () => {
    const url = await startQuant(quant([]));
    await new Promise((resolve) => server.close(resolve));
    vi.stubEnv("QUANT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const response = await (await route()).GET();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "the quant service could not be reached" });
  });

  it.each([
    ["not JSON", "<html>oops</html>"],
    ["not an array", { values: [] }],
    ["a fair value of 100", [{ ...VALUE, fair_cents: 100 }]],
    ["a fractional fair value", [{ ...VALUE, fair_cents: 57.5 }]],
    ["a missing market", [{ ...VALUE, market: undefined }]],
  ])("is 502 for %s (fails loudly, passes nothing on)", async (_name, payload) => {
    const url = await startQuant((_request, response) => {
      if (typeof payload === "string") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(payload);
      } else json(response, 200, payload);
    });
    vi.stubEnv("QUANT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const response = await (await route()).GET();
    expect(response.status).toBe(502);
  });
});
