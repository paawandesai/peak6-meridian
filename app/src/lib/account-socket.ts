/**
 * A minimal Solana pubsub client for `accountSubscribe` (P1-2). One socket per RPC endpoint
 * carries every account the open page watches. Unlike web3.js's `onAccountChange`, it reports
 * per-account liveness (socket open AND the subscription confirmed), which is what lets the
 * account feed slow its polling only while pushes can actually arrive. A dropped socket clears
 * every subscription at once, reconnects with capped exponential backoff and resubscribes.
 *
 * Never logs: the endpoint URL can carry an API key in its query string.
 */
import { z } from "zod";

/** Data and slot of one account; `data` is `null` when the account does not exist. */
export type AccountUpdate = (data: Uint8Array | null, slot: number) => void;

export type AccountSocket = {
  /** Watch `key`; a second call for the same key replaces its callback. */
  subscribe(key: string, onUpdate: AccountUpdate): void;
  unsubscribe(key: string): void;
  /** The socket is open and the server confirmed the subscription for `key`. */
  isLive(key: string): boolean;
  /** Fires whenever the liveness of any key may have changed. */
  onHealthChange(listener: () => void): () => void;
  close(): void;
};

export type SocketHandlers = {
  readonly onOpen: () => void;
  readonly onMessage: (data: string) => void;
  readonly onClose: () => void;
};

export type SocketConnection = {
  send(data: string): void;
  /** Closes without calling `onClose`. */
  close(): void;
};

/** Opens a socket to `url`; injectable so tests drive a fake server. */
export type ConnectSocket = (url: string, handlers: SocketHandlers) => SocketConnection;

export type AccountSocketOptions = {
  readonly connect: ConnectSocket;
  /** JSON keepalive interval (providers drop sockets idle for ~10 min). */
  readonly keepaliveMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** How long an unused socket stays open, so page navigation does not reconnect. */
  readonly lingerMs?: number;
  readonly random?: () => number;
};

/** The browser `WebSocket` behind {@link ConnectSocket}. */
export const browserConnect: ConnectSocket = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data === "string") handlers.onMessage(event.data);
  };
  // An error is always followed by a close event, which does the recovery.
  ws.onerror = () => undefined;
  ws.onclose = () => handlers.onClose();
  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
    },
  };
};

const responseSchema = z.object({ id: z.number(), result: z.unknown().optional() });
const notificationSchema = z.object({
  method: z.literal("accountNotification"),
  params: z.object({
    subscription: z.number(),
    result: z.object({
      context: z.object({ slot: z.number() }),
      value: z
        .object({
          lamports: z.number(),
          data: z.tuple([z.string(), z.literal("base64")]),
        })
        .nullable(),
    }),
  }),
});

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Reconnect delay for `attempt` (0-based): base · 2^attempt capped, with 50–100 % jitter. */
export function reconnectDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  return Math.round(Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + random() / 2));
}

type Sub = { onUpdate: AccountUpdate; requestId: number | null; subscriptionId: number | null };

export function createAccountSocket(url: string, options: AccountSocketOptions): AccountSocket {
  const {
    connect,
    keepaliveMs = 30_000,
    baseBackoffMs = 1_000,
    maxBackoffMs = 30_000,
    lingerMs = 5_000,
    random = Math.random,
  } = options;
  const subs = new Map<string, Sub>();
  const byRequest = new Map<number, string>();
  const bySubscription = new Map<number, string>();
  const listeners = new Set<() => void>();
  let conn: SocketConnection | null = null;
  let open = false;
  let attempts = 0;
  let nextId = 1;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const send = (message: object): void => conn?.send(JSON.stringify(message));

  const sendSubscribe = (key: string, sub: Sub): void => {
    const id = nextId;
    nextId += 1;
    sub.requestId = id;
    sub.subscriptionId = null;
    byRequest.set(id, key);
    send({
      jsonrpc: "2.0",
      id,
      method: "accountSubscribe",
      params: [key, { encoding: "base64", commitment: "confirmed" }],
    });
  };

  const sendUnsubscribe = (subscriptionId: number): void => {
    const id = nextId;
    nextId += 1;
    send({ jsonrpc: "2.0", id, method: "accountUnsubscribe", params: [subscriptionId] });
  };

  const resetSession = (): void => {
    open = false;
    byRequest.clear();
    bySubscription.clear();
    for (const sub of subs.values()) {
      sub.requestId = null;
      sub.subscriptionId = null;
    }
    if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  };

  const scheduleReconnect = (): void => {
    if (reconnectTimer !== null || subs.size === 0) return;
    const delay = reconnectDelayMs(attempts, baseBackoffMs, maxBackoffMs, random);
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (subs.size > 0 && conn === null) connectNow();
    }, delay);
  };

  const onOpen = (): void => {
    open = true;
    attempts = 0;
    for (const [key, sub] of subs) sendSubscribe(key, sub);
    keepaliveTimer = setInterval(
      () => send({ jsonrpc: "2.0", method: "ping", params: null }),
      keepaliveMs,
    );
  };

  const onResponse = (id: number, result: unknown): void => {
    const key = byRequest.get(id);
    if (key === undefined) return;
    byRequest.delete(id);
    const sub = subs.get(key);
    if (typeof result !== "number") return; // a rejected subscription stays polled
    if (sub === undefined || sub.requestId !== id) {
      sendUnsubscribe(result); // unwatched while the request was in flight
      return;
    }
    sub.subscriptionId = result;
    bySubscription.set(result, key);
    emit();
  };

  const onNotification = (message: z.infer<typeof notificationSchema>): void => {
    const key = bySubscription.get(message.params.subscription);
    const sub = key === undefined ? undefined : subs.get(key);
    if (sub === undefined) return;
    const { context, value } = message.params.result;
    // A closed account is reported with zero lamports; RPC reads report it as missing.
    const data = value === null || value.lamports === 0 ? null : fromBase64(value.data[0]);
    sub.onUpdate(data, context.slot);
  };

  const onMessage = (raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // not JSON-RPC; nothing to apply
    }
    const notification = notificationSchema.safeParse(parsed);
    if (notification.success) {
      onNotification(notification.data);
      return;
    }
    const response = responseSchema.safeParse(parsed);
    if (response.success) onResponse(response.data.id, response.data.result);
  };

  const onClose = (): void => {
    const wasLive = bySubscription.size > 0;
    conn = null;
    resetSession();
    if (wasLive) emit();
    scheduleReconnect();
  };

  function connectNow(): void {
    try {
      conn = connect(url, { onOpen, onMessage, onClose });
    } catch {
      conn = null;
      scheduleReconnect();
    }
  }

  const closeConnection = (): void => {
    const wasLive = bySubscription.size > 0;
    const current = conn;
    conn = null;
    resetSession();
    current?.close();
    if (wasLive) emit();
  };

  return {
    subscribe(key, onUpdate) {
      if (lingerTimer !== null) clearTimeout(lingerTimer);
      lingerTimer = null;
      const existing = subs.get(key);
      if (existing !== undefined) {
        existing.onUpdate = onUpdate;
        return;
      }
      const sub: Sub = { onUpdate, requestId: null, subscriptionId: null };
      subs.set(key, sub);
      if (open) sendSubscribe(key, sub);
      else if (conn === null && reconnectTimer === null) connectNow();
    },
    unsubscribe(key) {
      const sub = subs.get(key);
      if (sub === undefined) return;
      subs.delete(key);
      if (sub.subscriptionId !== null) {
        bySubscription.delete(sub.subscriptionId);
        if (open) sendUnsubscribe(sub.subscriptionId);
      }
      if (subs.size === 0) {
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        if (conn !== null && lingerTimer === null) {
          lingerTimer = setTimeout(() => {
            lingerTimer = null;
            if (subs.size === 0) closeConnection();
          }, lingerMs);
        }
      }
    },
    isLive: (key) => open && (subs.get(key)?.subscriptionId ?? null) !== null,
    onHealthChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (lingerTimer !== null) clearTimeout(lingerTimer);
      reconnectTimer = null;
      lingerTimer = null;
      subs.clear();
      closeConnection();
      listeners.clear();
    },
  };
}
