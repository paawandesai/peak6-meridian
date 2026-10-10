/** Test fakes for the account socket and feed (P1-2): a scripted pubsub server. */
import type { ConnectSocket, SocketHandlers } from "./account-socket";

type Sent = { id?: number; method: string; params: unknown };
type FakeSocket = { url: string; handlers: SocketHandlers; sent: Sent[]; closed: boolean };

/** A scripted pubsub server: every `connect` is recorded and driven by the test. */
export function fakeServer(options: { failConnect?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const connect: ConnectSocket = (url, handlers) => {
    if (options.failConnect === true) throw new Error("bad url");
    const socket: FakeSocket = { url, handlers, sent: [], closed: false };
    sockets.push(socket);
    return {
      send: (data) => socket.sent.push(JSON.parse(data) as Sent),
      close: () => {
        socket.closed = true;
      },
    };
  };
  const last = (): FakeSocket => {
    const socket = sockets[sockets.length - 1];
    if (socket === undefined) throw new Error("no socket");
    return socket;
  };
  const subscribes = (socket: FakeSocket = last()) =>
    socket.sent.filter((message) => message.method === "accountSubscribe");
  /** Confirms every pending subscription request with ids 100, 101, … */
  const confirmAll = (socket: FakeSocket = last(), base = 100) => {
    subscribes(socket).forEach((message, index) =>
      socket.handlers.onMessage(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: base + index }),
      ),
    );
  };
  const notify = (subscription: number, slot: number, value: unknown, socket = last()) =>
    socket.handlers.onMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "accountNotification",
        params: { subscription, result: { context: { slot }, value } },
      }),
    );
  /** Pushes `bytes` (or a missing account) for `key`, as confirmed by {@link confirmAll}. */
  const push = (key: string, slot: number, bytes: readonly number[] | null, socket = last()) => {
    const index = subscribes(socket).findIndex(
      (message) => Array.isArray(message.params) && message.params[0] === key,
    );
    if (index < 0) throw new Error(`no subscription for ${key}`);
    notify(
      100 + index,
      slot,
      bytes === null
        ? null
        : { lamports: 1, data: [Buffer.from(Uint8Array.from(bytes)).toString("base64"), "base64"] },
      socket,
    );
  };
  return { sockets, connect, last, subscribes, confirmAll, notify, push };
}

/**
 * A counting `fetchMany`: answers every key from `accounts` (missing key → `null`) at `slot`.
 * `calls` records each batched read's keys; `fail` makes the next reads reject.
 */
export function fakeFetcher(initial: Record<string, readonly number[] | null> = {}) {
  const state = {
    accounts: { ...initial } as Record<string, readonly number[] | null>,
    slot: 10,
    fail: null as string | null,
    calls: [] as (readonly string[])[],
  };
  const fetchMany = (keys: readonly string[]) => {
    state.calls.push([...keys]);
    if (state.fail !== null) return Promise.reject(new Error(state.fail));
    return Promise.resolve({
      slot: state.slot,
      values: keys.map((key) => {
        const bytes = state.accounts[key];
        return bytes === undefined || bytes === null ? null : Uint8Array.from(bytes);
      }),
    });
  };
  return { state, fetchMany };
}

let visibility: DocumentVisibilityState = "visible";

/** Drives `document.visibilityState` and fires `visibilitychange`, as a tab switch does. */
export function setVisibility(next: DocumentVisibilityState): void {
  if (next === visibility && document.visibilityState === next) return;
  visibility = next;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  document.dispatchEvent(new Event("visibilitychange"));
}
