import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AccountSocket,
  browserConnect,
  createAccountSocket,
  reconnectDelayMs,
} from "./account-socket";
import { fakeServer } from "./account-test-support";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

describe("browserConnect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  class FakeWebSocket {
    static readonly OPEN = 1;
    static last: FakeWebSocket | null = null;
    readyState = 0;
    sent: string[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {
      FakeWebSocket.last = this;
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.closed = true;
    }
  }

  it("wires the browser socket to the handlers and only sends while open", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const handlers = { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
    const conn = browserConnect("wss://x/", handlers);
    const ws = FakeWebSocket.last;
    if (ws === null) throw new Error("no socket");
    expect(ws.url).toBe("wss://x/");
    conn.send("early");
    expect(ws.sent).toEqual([]);
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.();
    conn.send("hello");
    ws.onmessage?.({ data: "msg" });
    ws.onmessage?.({ data: new Uint8Array(1) }); // binary frames are not JSON-RPC
    ws.onerror?.();
    ws.onclose?.();
    expect(ws.sent).toEqual(["hello"]);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);
    expect(handlers.onMessage).toHaveBeenCalledWith("msg");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("close() detaches the handlers so no close event is reported", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const handlers = { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
    browserConnect("wss://x/", handlers).close();
    const ws = FakeWebSocket.last;
    expect(ws?.closed).toBe(true);
    expect(ws?.onclose).toBeNull();
  });
});

describe("createAccountSocket", () => {
  let socket: AccountSocket | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    socket?.close();
    socket = null;
    vi.useRealTimers();
  });

  it("connects on the first subscription and subscribes with base64 at confirmed commitment", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://rpc.example/", { connect: server.connect });
    expect(server.sockets).toHaveLength(0); // lazy: no socket without subscriptions
    socket.subscribe("KeyA", () => undefined);
    expect(server.sockets).toHaveLength(1);
    expect(server.last().url).toBe("wss://rpc.example/");
    expect(server.subscribes()).toHaveLength(0); // waits for open
    server.last().handlers.onOpen();
    expect(server.subscribes()).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "accountSubscribe",
        params: ["KeyA", { encoding: "base64", commitment: "confirmed" }],
      },
    ]);
  });

  it("is live only once the server confirms, and reports the change", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect });
    const health = vi.fn();
    socket.onHealthChange(health);
    socket.subscribe("KeyA", () => undefined);
    server.last().handlers.onOpen();
    expect(socket.isLive("KeyA")).toBe(false);
    server.confirmAll();
    expect(socket.isLive("KeyA")).toBe(true);
    expect(health).toHaveBeenCalledTimes(1);
    expect(socket.isLive("Other")).toBe(false);
  });

  it("subscribes a key added after open straight away", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect });
    socket.subscribe("KeyA", () => undefined);
    server.last().handlers.onOpen();
    socket.subscribe("KeyB", () => undefined);
    expect(server.subscribes().map((m) => (m.params as unknown[])[0])).toEqual(["KeyA", "KeyB"]);
    expect(server.sockets).toHaveLength(1);
  });

  it("delivers decoded bytes and the slot; a closed or missing account is null", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect });
    const updates: [Uint8Array | null, number][] = [];
    socket.subscribe("KeyA", (data, slot) => updates.push([data, slot]));
    server.last().handlers.onOpen();
    server.confirmAll();
    server.notify(100, 7, { lamports: 5, data: [b64([1, 2, 3]), "base64"] });
    server.notify(100, 8, { lamports: 0, data: ["", "base64"] });
    server.notify(100, 9, null);
    expect(updates).toEqual([
      [new Uint8Array([1, 2, 3]), 7],
      [null, 8],
      [null, 9],
    ]);
  });

  it("ignores malformed messages, unknown subscriptions and stray responses", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect });
    const onUpdate = vi.fn();
    socket.subscribe("KeyA", onUpdate);
    server.last().handlers.onOpen();
    server.confirmAll();
    const { onMessage } = server.last().handlers;
    onMessage("not json");
    onMessage(JSON.stringify({ jsonrpc: "2.0", id: 999, result: 5 }));
    onMessage(JSON.stringify({ jsonrpc: "2.0", method: "slotNotification", params: {} }));
    onMessage(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601 }, id: null }));
    server.notify(555, 1, null); // not ours
    server.notify(100, 1, { lamports: 1, data: ["AA==", "base58"] }); // wrong encoding
    expect(onUpdate).not.toHaveBeenCalled();
    expect(socket.isLive("KeyA")).toBe(true);
  });

  it("leaves a rejected subscription not live (the feed keeps polling it)", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect });
    socket.subscribe("KeyA", () => undefined);
    server.last().handlers.onOpen();
    const id = server.subscribes()[0]?.id;
    server
      .last()
      .handlers.onMessage(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "bad key" } }),
      );
    expect(socket.isLive("KeyA")).toBe(false);
  });

  it("on a drop: not live at once, reconnects with backoff and resubscribes", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", {
      connect: server.connect,
      baseBackoffMs: 1_000,
      random: () => 1,
    });
    const health = vi.fn();
    socket.onHealthChange(health);
    socket.subscribe("KeyA", () => undefined);
    server.last().handlers.onOpen();
    server.confirmAll();
    health.mockClear();
    server.last().handlers.onClose();
    expect(socket.isLive("KeyA")).toBe(false);
    expect(health).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(server.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(server.sockets).toHaveLength(2);
    // A failed attempt doubles the delay.
    server.last().handlers.onClose();
    vi.advanceTimersByTime(1_999);
    expect(server.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(server.sockets).toHaveLength(3);
    server.last().handlers.onOpen();
    expect(server.subscribes()).toHaveLength(1);
    server.confirmAll();
    expect(socket.isLive("KeyA")).toBe(true);
  });

  it("retries when the socket cannot even be constructed", () => {
    const server = fakeServer({ failConnect: true });
    const connect = vi.fn(server.connect);
    socket = createAccountSocket("wss://x/", { connect, baseBackoffMs: 100, random: () => 1 });
    socket.subscribe("KeyA", () => undefined);
    expect(connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(socket.isLive("KeyA")).toBe(false);
  });

  it("unsubscribes on the server, and closes the socket after the linger once unused", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect, lingerMs: 5_000 });
    socket.subscribe("KeyA", () => undefined);
    server.last().handlers.onOpen();
    server.confirmAll();
    socket.unsubscribe("KeyA");
    expect(server.last().sent.at(-1)).toMatchObject({
      method: "accountUnsubscribe",
      params: [100],
    });
    expect(socket.isLive("KeyA")).toBe(false);
    vi.advanceTimersByTime(4_999);
    expect(server.last().closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(server.last().closed).toBe(true);
    socket.unsubscribe("never-watched"); // no-op
  });

  it("a key re-watched within the linger reuses the open socket", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect, lingerMs: 5_000 });
    socket.subscribe("KeyA", () => undefined);
    server.last().handlers.onOpen();
    socket.unsubscribe("KeyA");
    socket.subscribe("KeyB", () => undefined);
    vi.advanceTimersByTime(10_000);
    expect(server.sockets).toHaveLength(1);
    expect(server.last().closed).toBe(false);
  });

  it("drops a subscription confirmed after its key was unwatched", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect });
    socket.subscribe("KeyA", () => undefined);
    server.last().handlers.onOpen();
    socket.unsubscribe("KeyA");
    server.confirmAll();
    expect(server.last().sent.at(-1)).toMatchObject({
      method: "accountUnsubscribe",
      params: [100],
    });
    expect(socket.isLive("KeyA")).toBe(false);
  });

  it("replaces the callback when a key is subscribed twice (one server subscription)", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect });
    const first = vi.fn();
    const second = vi.fn();
    socket.subscribe("KeyA", first);
    socket.subscribe("KeyA", second);
    server.last().handlers.onOpen();
    server.confirmAll();
    server.notify(100, 1, null);
    expect(server.subscribes()).toHaveLength(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(null, 1);
  });

  it("sends a JSON keepalive while open", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect, keepaliveMs: 30_000 });
    socket.subscribe("KeyA", () => undefined);
    server.last().handlers.onOpen();
    vi.advanceTimersByTime(60_000);
    expect(server.last().sent.filter((m) => m.method === "ping")).toHaveLength(2);
    server.last().handlers.onClose();
    const sent = server.sockets[0]?.sent.length;
    vi.advanceTimersByTime(60_000);
    expect(server.sockets[0]?.sent.length).toBe(sent); // no pings on a closed socket
  });

  it("does not reconnect when the drop leaves nothing watched", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect });
    socket.subscribe("KeyA", () => undefined);
    socket.unsubscribe("KeyA");
    server.last().handlers.onClose();
    vi.advanceTimersByTime(120_000);
    expect(server.sockets).toHaveLength(1);
  });

  it("close() tears everything down and reports not live", () => {
    const server = fakeServer();
    socket = createAccountSocket("wss://x/", { connect: server.connect });
    const health = vi.fn();
    socket.onHealthChange(health);
    socket.subscribe("KeyA", () => undefined);
    server.last().handlers.onOpen();
    server.confirmAll();
    health.mockClear();
    socket.close();
    expect(server.last().closed).toBe(true);
    expect(socket.isLive("KeyA")).toBe(false);
    expect(health).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(server.sockets).toHaveLength(1);
  });
});

describe("reconnectDelayMs", () => {
  it("is 50–100 % of min(max, base·2^attempt)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 120_000 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (attempt, base, max, r) => {
          const cap = Math.min(max, base * 2 ** attempt);
          const delay = reconnectDelayMs(attempt, base, max, () => r);
          return delay >= Math.floor(cap / 2) && delay <= Math.ceil(cap);
        },
      ),
    );
  });
});
