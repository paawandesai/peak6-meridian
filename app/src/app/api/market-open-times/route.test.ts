// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "svc-token-do-not-leak";
const BODY = {
  ready: true,
  as_of: "2026-10-09T12:05:00.000Z",
  markets: [
    {
      market: "Mkt1111111111111111111111111111111111111111",
      opened_at: 1_791_288_000,
      signature:
        "5ig111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
    },
  ],
};

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
let server: Server | undefined;
let seen: { path: string; auth: string | undefined }[] = [];

/** A mocked automation service speaking the documented `/markets` contract. */
async function startAutomation(handler: Handler): Promise<string> {
  seen = [];
  const created = createServer((request, response) => {
    seen.push({ path: request.url ?? "", auth: request.headers.authorization });
    handler(request, response);
  });
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

const automation =
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
  const current = server;
  server = undefined;
  if (current?.listening) await new Promise((resolve) => current.close(resolve));
});

describe("GET /api/market-open-times", () => {
  it("proxies /markets with the bearer token added server-side, and never echoes it", async () => {
    vi.stubEnv("AUTOMATION_URL", await startAutomation(automation(BODY)));
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const response = await (await route()).GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(BODY);
    expect(text).not.toContain(TOKEN);
    expect(seen).toEqual([{ path: "/markets", auth: `Bearer ${TOKEN}` }]);
  });

  it("drops undocumented fields", async () => {
    vi.stubEnv(
      "AUTOMATION_URL",
      await startAutomation(
        automation({ ...BODY, secret: "x", markets: [{ ...BODY.markets[0], extra: 1 }] }),
      ),
    );
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const body: unknown = await (await (await route()).GET()).json();
    expect(body).toEqual(BODY);
  });

  it("is 503 when AUTOMATION_URL or SERVICE_TOKEN is missing or the URL is not http(s)", async () => {
    for (const [url, token] of [
      [undefined, TOKEN],
      ["   ", TOKEN],
      ["ftp://automation.internal", TOKEN],
      ["not a url", TOKEN],
      ["http://127.0.0.1:1", undefined],
      ["http://127.0.0.1:1", ""],
    ] as const) {
      vi.unstubAllEnvs();
      if (url !== undefined) vi.stubEnv("AUTOMATION_URL", url);
      else vi.stubEnv("AUTOMATION_URL", undefined as unknown as string);
      if (token !== undefined) vi.stubEnv("SERVICE_TOKEN", token);
      else vi.stubEnv("SERVICE_TOKEN", undefined as unknown as string);
      const response = await (await route()).GET();
      expect(response.status, String(url)).toBe(503);
      expect(await response.json()).toEqual({ error: "the automation service is not configured" });
    }
  });

  it("is 502 when the service is unreachable", async () => {
    const base = await startAutomation(automation(BODY));
    await new Promise((resolve) => server?.close(resolve));
    vi.stubEnv("AUTOMATION_URL", base);
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const response = await (await route()).GET();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "the automation service could not be reached" });
  });

  it("is 502 on an error status (e.g. a wrong token), without the upstream body", async () => {
    vi.stubEnv("AUTOMATION_URL", await startAutomation(automation(BODY)));
    vi.stubEnv("SERVICE_TOKEN", "wrong-token");
    const response = await (await route()).GET();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "the automation service answered 401" });
  });

  it("is 502 on a body that is not JSON or not the documented shape", async () => {
    vi.stubEnv(
      "AUTOMATION_URL",
      await startAutomation((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("<html>");
      }),
    );
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    expect((await (await route()).GET()).status).toBe(502);

    for (const bad of [
      { ...BODY, ready: "yes" },
      { ...BODY, markets: [{ ...BODY.markets[0], opened_at: 1.5 }] },
      { ...BODY, markets: [{ ...BODY.markets[0], opened_at: -1 }] },
      { ...BODY, as_of: "yesterday" },
      [],
    ]) {
      const current = server;
      if (current?.listening) await new Promise((resolve) => current.close(resolve));
      vi.stubEnv("AUTOMATION_URL", await startAutomation(automation(bad)));
      const response = await (await route()).GET();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "the automation service returned open times in an unexpected shape",
      });
    }
  });
});
