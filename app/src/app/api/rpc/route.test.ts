/**
 * RPC proxy tests (P0-5): verify method allowlist, key limits, caching, rate limiting, and fallback.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Mock NextRequest and NextResponse
class MockNextRequest {
  headers: Map<string, string>;
  bodyContent: unknown;

  constructor(body: unknown, headers: Record<string, string> = {}) {
    this.headers = new Map(Object.entries(headers));
    this.bodyContent = body;
  }

  get(key: string): string | null {
    return this.headers.get(key) ?? null;
  }

  async json(): Promise<unknown> {
    return this.bodyContent;
  }
}

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock environment
const originalEnv = process.env;

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  process.env.SOLANA_RPC_URL = "https://test-rpc.example.com";
  delete process.env.SOLANA_RPC_URL_FALLBACK;
});

function createRequest(body: unknown, ip = "127.0.0.1"): unknown {
  return new MockNextRequest(body, { "x-forwarded-for": ip });
}

describe("RPC Proxy - Method Allowlist (P0-5 AC)", () => {
  it("allows getAccountInfo", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { value: {} } }),
    });

    const req = createRequest({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: ["DummyPubkey"],
      id: 1,
    });

    const response = await POST(req as never);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.result).toBeDefined();
  });

  it("allows getMultipleAccounts", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { value: [] } }),
    });

    const req = createRequest({
      jsonrpc: "2.0",
      method: "getMultipleAccounts",
      params: [["Key1", "Key2"]],
      id: 2,
    });

    const response = await POST(req as never);
    expect(response.status).toBe(200);
  });

  it("allows sendTransaction", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "signature123" }),
    });

    const req = createRequest({
      jsonrpc: "2.0",
      method: "sendTransaction",
      params: ["base64TxData"],
      id: 3,
    });

    const response = await POST(req as never);
    expect(response.status).toBe(200);
  });

  it("rejects disallowed method with 403", async () => {
    const req = createRequest({
      jsonrpc: "2.0",
      method: "someDisallowedMethod",
      params: [],
      id: 4,
    });

    const response = await POST(req as never);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.message).toContain("not allowed");
  });

  it("rejects getBlock (not in allowlist)", async () => {
    const req = createRequest({
      jsonrpc: "2.0",
      method: "getBlock",
      params: [123],
      id: 5,
    });

    const response = await POST(req as never);
    expect(response.status).toBe(403);
  });
});

describe("RPC Proxy - Multi-Account Key Limits (P0-5 AC)", () => {
  it("accepts ≤99 keys in getMultipleAccounts", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { value: [] } }),
    });

    const keys = Array.from({ length: 99 }, (_, i) => `Key${i}`);
    const req = createRequest({
      jsonrpc: "2.0",
      method: "getMultipleAccounts",
      params: [keys],
      id: 6,
    });

    const response = await POST(req as never);
    expect(response.status).toBe(200);
  });

  it("rejects >99 keys in getMultipleAccounts", async () => {
    const keys = Array.from({ length: 100 }, (_, i) => `Key${i}`);
    const req = createRequest({
      jsonrpc: "2.0",
      method: "getMultipleAccounts",
      params: [keys],
      id: 7,
    });

    const response = await POST(req as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Too many keys");
    expect(data.error.message).toContain("100");
  });

  it("rejects 120 keys", async () => {
    const keys = Array.from({ length: 120 }, (_, i) => `Key${i}`);
    const req = createRequest({
      jsonrpc: "2.0",
      method: "getMultipleAccounts",
      params: [keys],
      id: 8,
    });

    const response = await POST(req as never);
    expect(response.status).toBe(400);
  });
});

describe("RPC Proxy - Caching (P0-5)", () => {
  it("caches read operations (getAccountInfo)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { value: { data: "test" } } }),
    });

    const req1 = createRequest({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: ["CachedKey"],
      id: 9,
    });

    const response1 = await POST(req1 as never);
    const data1 = await response1.json();

    // Second request with same params should use cache
    const req2 = createRequest({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: ["CachedKey"],
      id: 10,
    });

    const response2 = await POST(req2 as never);
    const data2 = await response2.json();

    expect(data1.result).toEqual(data2.result);
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only called once, second used cache
  });

  it("does not cache sendTransaction", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "sig1" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "sig2" }),
      });

    const req1 = createRequest({
      jsonrpc: "2.0",
      method: "sendTransaction",
      params: ["tx1"],
      id: 11,
    });

    await POST(req1 as never);

    const req2 = createRequest({
      jsonrpc: "2.0",
      method: "sendTransaction",
      params: ["tx1"],
      id: 12,
    });

    await POST(req2 as never);

    expect(mockFetch).toHaveBeenCalledTimes(2); // Both requests hit RPC
  });
});

describe("RPC Proxy - Rate Limiting (P0-5 AC)", () => {
  it("allows requests within rate limit", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: {} }),
    });

    // Make 5 requests from same IP
    for (let i = 0; i < 5; i++) {
      const req = createRequest(
        {
          jsonrpc: "2.0",
          method: "getSlot",
          params: [],
          id: i,
        },
        "192.168.1.1"
      );

      const response = await POST(req as never);
      expect(response.status).toBe(200);
    }
  });

  it("rate limits excessive requests from same IP", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: {} }),
    });

    const testIp = "192.168.1.100";

    // Exhaust rate limit (60 requests per minute)
    const requests = [];
    for (let i = 0; i < 62; i++) {
      const req = createRequest(
        {
          jsonrpc: "2.0",
          method: "getSlot",
          params: [],
          id: `ratelimit-${i}`,
        },
        testIp
      );
      requests.push(POST(req as never));
    }

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status);

    // Some requests should be rate limited (429)
    const rateLimited = statuses.filter((s) => s === 429);
    expect(rateLimited.length).toBeGreaterThan(0);
  });

  it("allows requests from different IPs independently", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: {} }),
    });

    const req1 = createRequest(
      { jsonrpc: "2.0", method: "getSlot", params: [], id: 1 },
      "10.0.0.1"
    );
    const req2 = createRequest(
      { jsonrpc: "2.0", method: "getSlot", params: [], id: 2 },
      "10.0.0.2"
    );

    const response1 = await POST(req1 as never);
    const response2 = await POST(req2 as never);

    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);
  });
});

describe("RPC Proxy - Fallback on 429/5xx (P0-5 AC)", () => {
  it("uses fallback when primary returns 429", async () => {
    process.env.SOLANA_RPC_URL_FALLBACK = "https://fallback-rpc.example.com";

    // First call fails with 429
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({}),
    });

    // Second call (fallback) succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { slot: 12345 } }),
    });

    // Use unique params to avoid cache
    const req = createRequest({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: ["FallbackTest429Unique"],
      id: 13,
    });

    const response = await POST(req as never);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.result).toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("uses fallback when primary returns 500", async () => {
    process.env.SOLANA_RPC_URL_FALLBACK = "https://fallback-rpc.example.com";

    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: {} }),
      });

    const req = createRequest({
      jsonrpc: "2.0",
      method: "getBalance",
      params: ["test"],
      id: 14,
    });

    const response = await POST(req as never);
    expect(response.status).toBe(200);
  });

  it("returns error when both primary and fallback fail", async () => {
    process.env.SOLANA_RPC_URL_FALLBACK = "https://fallback-rpc.example.com";

    // Primary fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Error",
      json: async () => ({}),
    });

    // Fallback also fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Error",
      json: async () => ({}),
    });

    // Use unique params to avoid cache
    const req = createRequest({
      jsonrpc: "2.0",
      method: "getAccountInfo",
      params: ["BothFail500Key"],
      id: 15,
    });

    const response = await POST(req as never);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBeDefined();
  });
});

describe("RPC Proxy - Input Validation", () => {
  it("rejects invalid JSON", async () => {
    const req = {
      headers: new Map([["x-forwarded-for", "127.0.0.1"]]),
      json: async () => {
        throw new Error("Invalid JSON");
      },
    };

    const response = await POST(req as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe(-32700);
  });

  it("rejects missing method", async () => {
    const req = createRequest({
      jsonrpc: "2.0",
      params: [],
      id: 16,
    });

    const response = await POST(req as never);
    expect(response.status).toBe(400);
  });
});
