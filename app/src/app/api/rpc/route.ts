/**
 * RPC proxy (P0-5): server-side JSON-RPC proxy to SOLANA_RPC_URL.
 * - Method allowlist (403 for disallowed methods)
 * - ≤99 keys per multi-account call
 * - 1-2s micro-cache for identical reads
 * - In-flight request deduplication
 * - Per-IP token bucket rate limiting
 * - URL redaction in logs
 * - Optional fallback rotation on 429/5xx
 */

import { NextRequest, NextResponse } from "next/server";

/** Allowed RPC methods (P0-5 AC). */
const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getSignaturesForAddress",
  "getTransaction",
  "getTokenAccountsByOwner",
  "getParsedTokenAccountsByOwner",
  "getBalance",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "simulateTransaction",
  "sendTransaction",
  "getSlot",
  "getMinimumBalanceForRentExemption",
]);

/** Maximum keys allowed in multi-account calls (Solana limit is 100). */
const MAX_KEYS_PER_CALL = 99;

/** Cache TTL for read operations (1-2s micro-cache). */
const CACHE_TTL_MS = 1500;

/** Rate limit: requests per IP per minute. */
const RATE_LIMIT_PER_MINUTE = 60;

/** Simple in-memory cache for read operations. */
const cache = new Map<string, { value: unknown; expiresAt: number }>();

/** In-flight request deduplication. */
const inFlight = new Map<string, Promise<unknown>>();

/** Per-IP token bucket rate limiter. */
const rateLimits = new Map<string, { tokens: number; lastRefill: number }>();

/**
 * Redact RPC URL for logs (P0-5): remove any key embedded in query params or path.
 */
function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove query params that might contain keys
    parsed.search = "";
    // Replace path segments that look like keys (long alphanumeric strings)
    const redactedPath = parsed.pathname
      .split("/")
      .map((segment) => {
        // If segment looks like a key (>20 chars alphanumeric), redact it
        if (segment.length > 20 && /^[a-zA-Z0-9-_]+$/.test(segment)) {
          return "[REDACTED]";
        }
        return segment;
      })
      .join("/");
    parsed.pathname = redactedPath;
    return parsed.toString();
  } catch {
    return "[INVALID_URL]";
  }
}

/**
 * Get client IP from request headers.
 */
function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Check and update rate limit for an IP.
 * Returns true if request is allowed, false if rate limited.
 */
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const limit = rateLimits.get(ip);

  if (!limit) {
    // First request from this IP
    rateLimits.set(ip, { tokens: RATE_LIMIT_PER_MINUTE - 1, lastRefill: now });
    return true;
  }

  // Refill tokens based on time elapsed (token bucket algorithm)
  const elapsedMs = now - limit.lastRefill;
  const tokensToAdd = Math.floor((elapsedMs / 60000) * RATE_LIMIT_PER_MINUTE);

  if (tokensToAdd > 0) {
    limit.tokens = Math.min(RATE_LIMIT_PER_MINUTE, limit.tokens + tokensToAdd);
    limit.lastRefill = now;
  }

  if (limit.tokens > 0) {
    limit.tokens--;
    return true;
  }

  return false;
}

/**
 * Validate and extract keys from multi-account calls.
 * Returns error message if validation fails, null if valid.
 */
function validateMultiAccountKeys(params: unknown[]): string | null {
  if (!Array.isArray(params) || params.length === 0) {
    return null; // Not a multi-account call or no params
  }

  const firstParam = params[0];

  // getMultipleAccounts: first param is array of pubkeys
  if (Array.isArray(firstParam)) {
    if (firstParam.length > MAX_KEYS_PER_CALL) {
      return `Too many keys: ${firstParam.length} (max ${MAX_KEYS_PER_CALL})`;
    }
  }

  return null;
}

/**
 * Generate cache key for a request.
 */
function getCacheKey(method: string, params: unknown[]): string {
  return `${method}:${JSON.stringify(params)}`;
}

/**
 * Check if method is cacheable (read-only operations).
 */
function isCacheable(method: string): boolean {
  const writeOps = new Set(["sendTransaction", "simulateTransaction"]);
  return !writeOps.has(method);
}

/**
 * Clean up expired cache entries (run periodically).
 */
function cleanupCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt < now) {
      cache.delete(key);
    }
  }
}

// Clean up cache every 5 seconds
if (typeof setInterval !== "undefined") {
  setInterval(cleanupCache, 5000);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(request);

  // Rate limiting check
  if (!checkRateLimit(ip)) {
    console.warn(`[rpc-proxy] Rate limit exceeded for IP: ${ip}`);
    return NextResponse.json({ error: "Rate limit exceeded. Try again later." }, { status: 429 });
  }

  let body: { jsonrpc?: string; method?: string; params?: unknown[]; id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
      { status: 400 },
    );
  }

  const { method, params = [], id } = body;

  // Validate JSON-RPC structure
  if (!method || typeof method !== "string") {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: id ?? null },
      { status: 400 },
    );
  }

  // Method allowlist check
  if (!ALLOWED_METHODS.has(method)) {
    console.warn(`[rpc-proxy] Disallowed method: ${method} from IP: ${ip}`);
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32601, message: "Method not allowed" }, id },
      { status: 403 },
    );
  }

  // Validate multi-account call keys
  const keysError = validateMultiAccountKeys(params);
  if (keysError) {
    console.warn(`[rpc-proxy] ${keysError} in ${method} from IP: ${ip}`);
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32602, message: keysError }, id },
      { status: 400 },
    );
  }

  // Check cache for read operations
  const cacheKey = getCacheKey(method, params);
  if (isCacheable(method)) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({ jsonrpc: "2.0", result: cached.value, id });
    }

    // Check in-flight deduplication
    const pending = inFlight.get(cacheKey);
    if (pending) {
      try {
        const result = await pending;
        return NextResponse.json({ jsonrpc: "2.0", result, id });
      } catch {
        // Fall through to make new request
      }
    }
  }

  // Get RPC URL from environment
  const rpcUrl =
    process.env.MERIDIAN_DEVNET_RPC_URL?.trim() ||
    process.env.SOLANA_RPC_URL ||
    "https://api.devnet.solana.com";
  const fallbackUrl = process.env.SOLANA_RPC_URL_FALLBACK;

  const makeRequest = async (url: string): Promise<unknown> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    });

    if (!response.ok) {
      // Log with redacted URL
      console.error(
        `[rpc-proxy] RPC request failed: ${response.status} ${response.statusText} to ${redactRpcUrl(url)}`,
      );

      // If 429 or 5xx and fallback available, throw to try fallback
      if (
        (response.status === 429 || response.status >= 500) &&
        fallbackUrl &&
        url !== fallbackUrl
      ) {
        throw new Error(`Primary RPC failed: ${response.status}`);
      }

      throw new Error(`RPC request failed: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "RPC error");
    }

    return data.result;
  };

  try {
    // Start request and track in-flight for deduplication
    const requestPromise = makeRequest(rpcUrl);
    if (isCacheable(method)) {
      inFlight.set(cacheKey, requestPromise);
    }

    const result = await requestPromise;

    // Cache successful read operations
    if (isCacheable(method)) {
      cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
      inFlight.delete(cacheKey);
    }

    return NextResponse.json({ jsonrpc: "2.0", result, id });
  } catch (primaryError) {
    // Try fallback if available and primary failed with 429/5xx
    if (fallbackUrl && fallbackUrl !== rpcUrl) {
      try {
        console.log(`[rpc-proxy] Trying fallback RPC: ${redactRpcUrl(fallbackUrl)}`);
        const result = await makeRequest(fallbackUrl);

        // Cache successful fallback result
        if (isCacheable(method)) {
          cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
          inFlight.delete(cacheKey);
        }

        return NextResponse.json({ jsonrpc: "2.0", result, id });
      } catch (fallbackError) {
        console.error(
          `[rpc-proxy] Fallback RPC also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
      }
    }

    // Clean up in-flight on error
    if (isCacheable(method)) {
      inFlight.delete(cacheKey);
    }

    const errorMessage = primaryError instanceof Error ? primaryError.message : "Unknown error";
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32000, message: errorMessage }, id },
      { status: 500 },
    );
  }
}
