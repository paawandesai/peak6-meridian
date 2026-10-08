/**
 * `GET /health` (architecture.md § Service HTTP contracts): last morning and settlement run and
 * recent failures, behind `Authorization: Bearer <SERVICE_TOKEN>`. Anything else is 404/405.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface HealthServerDeps {
  readonly token: string;
  /** The JSON body of `/health`. */
  readonly health: () => unknown;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time check of a `Bearer` header against the expected token. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (header === undefined || !header.startsWith(prefix)) {
    return false;
  }
  return timingSafeEqual(digest(header.slice(prefix.length)), digest(token));
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function createHealthServer(deps: HealthServerDeps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/health") {
      send(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" }, { Allow: "GET" });
      return;
    }
    if (!bearerMatches(req.headers.authorization, deps.token)) {
      send(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }
    send(res, 200, deps.health());
  });
}
