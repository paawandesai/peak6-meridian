import { renderHook, waitFor } from "@testing-library/react";
import type { AccountInfo, Commitment, PublicKey } from "@solana/web3.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAccountSubscription } from "./use-account-subscription";

type AccountChangeCallback = (accountInfo: AccountInfo<Buffer> | null) => void;

class MockConnection {
  private listeners: Map<string, { callback: AccountChangeCallback; id: number }> = new Map();
  private nextId = 1;

  onAccountChange(
    publicKey: PublicKey,
    callback: AccountChangeCallback,
    _commitment?: Commitment,
  ): number {
    const id = this.nextId++;
    this.listeners.set(publicKey.toBase58(), { callback, id });
    return id;
  }

  removeAccountChangeListener(subscriptionId: number): Promise<void> {
    for (const [key, value] of this.listeners.entries()) {
      if (value.id === subscriptionId) {
        this.listeners.delete(key);
        break;
      }
    }
    return Promise.resolve();
  }

  triggerAccountChange(publicKey: PublicKey): void {
    const listener = this.listeners.get(publicKey.toBase58());
    if (listener !== undefined) {
      listener.callback(null);
    }
  }

  getListenerCount(): number {
    return this.listeners.size;
  }
}

class MockPublicKey {
  constructor(private readonly value: string) {}

  toBase58(): string {
    return this.value;
  }
}

describe("useAccountSubscription", () => {
  let mockConnection: MockConnection;
  let mockLoad: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockConnection = new MockConnection();
    mockLoad = vi.fn();
  });

  it("returns loading status initially", () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValue({ data: "test" });

    const { result } = renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key",
      ),
    );

    expect(result.current.state).toEqual({ status: "loading" });
  });

  it("loads initial data and subscribes", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValue({ data: "test" });

    const { result } = renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key",
      ),
    );

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "ready", value: { data: "test" } });
    });

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockConnection.getListenerCount()).toBe(1);
  });

  it("reloads data when account changes", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValueOnce({ data: "initial" }).mockResolvedValueOnce({ data: "updated" });

    const { result } = renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key",
      ),
    );

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "ready", value: { data: "initial" } });
    });

    mockConnection.triggerAccountChange(key1);

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "ready", value: { data: "updated" } });
    });

    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("handles load errors", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockRejectedValue(new Error("Connection failed"));

    const { result } = renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key",
      ),
    );

    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "error",
        message: "Connection failed",
      });
    });
  });

  it("returns loading when connection is null", () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValue({ data: "test" });

    const { result } = renderHook(() =>
      useAccountSubscription(null, [key1], mockLoad, 1000, "test-key"),
    );

    expect(result.current.state).toEqual({ status: "loading" });
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("returns loading when keys array is empty", () => {
    mockLoad.mockResolvedValue({ data: "test" });

    const { result } = renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [],
        mockLoad,
        1000,
        "test-key",
      ),
    );

    expect(result.current.state).toEqual({ status: "loading" });
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("subscribes to multiple keys", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    const key2 = new MockPublicKey("key2") as unknown as PublicKey;
    mockLoad.mockResolvedValue({ data: "test" });

    const { result } = renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1, key2],
        mockLoad,
        1000,
        "test-key",
      ),
    );

    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });

    expect(mockConnection.getListenerCount()).toBe(2);
  });
});
