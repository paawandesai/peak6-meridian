// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { draft } from "@/components/admin-override/test-support";

const TOKEN = "svc-token-do-not-leak";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
let server: Server;
let seen: { path: string; auth: string | undefined }[] = [];

/** A mocked ops-agent: the real HTTP contract, no real service. */
async function startAgent(handler: Handler): Promise<string> {
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

/** The agent as M3-05 serves it: 401 without the right bearer, drafts with it. */
const agent =
  (drafts: unknown): Handler =>
  (request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`)
      return json(response, 401, { error: "no" });
    json(response, 200, drafts);
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

describe("GET /api/ops/drafts", () => {
  it("sends the server-side bearer, returns the drafts and never the token", async () => {
    const url = await startAgent(agent([draft(), draft({ incident_id: "inc-2" })]));
    vi.stubEnv("OPS_AGENT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const { GET } = await route();
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual([draft(), draft({ incident_id: "inc-2" })]);
    expect(text).not.toContain(TOKEN);
    expect(seen).toEqual([{ path: "/drafts", auth: `Bearer ${TOKEN}` }]);
  });

  it("passes the price in integer cents unchanged", async () => {
    const url = await startAgent(agent([draft({ proposed_price_cents: 123_456_789 })]));
    vi.stubEnv("OPS_AGENT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const body = (await (await (await route()).GET()).json()) as { proposed_price_cents: number }[];
    expect(body[0]?.proposed_price_cents).toBe(123_456_789);
  });

  it("returns only the documented fields", async () => {
    const url = await startAgent(
      agent([{ ...draft(), fallback: true, secret: "x", api_key: "k" }]),
    );
    vi.stubEnv("OPS_AGENT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const text = await (await (await route()).GET()).text();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("api_key");
    expect(text).not.toContain("fallback");
  });

  it("is 503 when the agent URL or the token is not configured", async () => {
    for (const env of [
      { OPS_AGENT_URL: "", SERVICE_TOKEN: TOKEN },
      { OPS_AGENT_URL: "http://127.0.0.1:1", SERVICE_TOKEN: "" },
      { OPS_AGENT_URL: "not a url", SERVICE_TOKEN: TOKEN },
      { OPS_AGENT_URL: "ftp://example.test", SERVICE_TOKEN: TOKEN },
    ]) {
      vi.stubEnv("OPS_AGENT_URL", env.OPS_AGENT_URL);
      vi.stubEnv("SERVICE_TOKEN", env.SERVICE_TOKEN);
      const response = await (await route()).GET();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(TOKEN);
    }
  });

  it("is 502 without leaking when the agent rejects the token", async () => {
    const url = await startAgent(agent([draft()]));
    vi.stubEnv("OPS_AGENT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", "wrong-token");
    const response = await (await route()).GET();
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("answered 401");
    expect(text).not.toContain("wrong-token");
  });

  it("is 502 when the agent is down", async () => {
    const url = await startAgent(agent([]));
    await new Promise((resolve) => server.close(resolve));
    vi.stubEnv("OPS_AGENT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const response = await (await route()).GET();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "the ops agent could not be reached" });
  });

  it.each([
    ["not JSON", "<html>oops</html>"],
    ["not an array", { drafts: [] }],
    ["a draft missing its price", [{ ...draft(), proposed_price_cents: undefined }]],
    ["a fractional price", [draft({ proposed_price_cents: 181.42 })]],
    ["a zero price", [draft({ proposed_price_cents: 0 })]],
    ["a market that is not an address", [draft({ market: "https://evil.test" })]],
    ["a source with no close", [draft({ sources: [] })]],
  ])("is 502 for %s (fails loudly, passes nothing on)", async (_name, payload) => {
    const url = await startAgent((request, response) => {
      if (typeof payload === "string") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(payload);
      } else json(response, 200, payload);
      void request;
    });
    vi.stubEnv("OPS_AGENT_URL", url);
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
    const response = await (await route()).GET();
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
