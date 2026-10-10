import { renderHook, waitFor } from "@testing-library/react";
import type { AccountInfo, Commitment, PublicKey } from "@solana/web3.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  // Test helper
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

  toString(): string {
    return this.value;
  }
}

describe("useAccountSubscription", () => {
  let mockConnection: MockConnection;
  let mockLoad: ReturnType<typeof vi.fn>;
  let originalHidden: PropertyDescriptor | undefined;

  beforeEach(() => {
    mockConnection = new MockConnection();
    mockLoad = vi.fn();

    // Mock document.hidden
    originalHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHidden !== undefined) {
      Object.defineProperty(Document.prototype, "hidden", originalHidden);
    }
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

  it("handles load errors and keeps last good value", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad
      .mockResolvedValueOnce({ data: "good" })
      .mockRejectedValueOnce(new Error("Network error"));

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
      expect(result.current.state).toEqual({ status: "ready", value: { data: "good" } });
    });

    mockConnection.triggerAccountChange(key1);

    // Should keep the last good value even after error
    await waitFor(() => {
      expect(mockLoad).toHaveBeenCalledTimes(2);
    });
    expect(result.current.state).toEqual({ status: "ready", value: { data: "good" } });
  });

  it("shows error status when initial load fails", async () => {
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

  it("deduplicates subscriptions for same keys across components", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValue({ data: "test" });

    const { result: result1 } = renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key-1",
      ),
    );

    const { result: result2 } = renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key-2",
      ),
    );

    await waitFor(() => {
      expect(result1.current.state.status).toBe("ready");
      expect(result2.current.state.status).toBe("ready");
    });

    // Should only have one subscription despite two components
    expect(mockConnection.getListenerCount()).toBe(1);
  });

  it("cleans up subscriptions on unmount", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValue({ data: "test" });

    const { unmount } = renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key",
      ),
    );

    await waitFor(() => {
      expect(mockConnection.getListenerCount()).toBe(1);
    });

    unmount();

    await waitFor(() => {
      expect(mockConnection.getListenerCount()).toBe(0);
    });
  });

  it("keeps subscription alive when one component unmounts but others remain", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValue({ data: "test" });

    const { unmount: unmount1 } = renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key-1",
      ),
    );

    renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key-2",
      ),
    );

    await waitFor(() => {
      expect(mockConnection.getListenerCount()).toBe(1);
    });

    unmount1();

    // Subscription should still exist because result2 is still mounted
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockConnection.getListenerCount()).toBe(1);
  });

  it("cleans up when tab is hidden", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValue({ data: "test" });

    renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key",
      ),
    );

    await waitFor(() => {
      expect(mockConnection.getListenerCount()).toBe(1);
    });

    // Simulate tab hidden
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(mockConnection.getListenerCount()).toBe(0);
    });
  });

  it("re-establishes subscriptions when tab becomes visible", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValue({ data: "test" });

    renderHook(() =>
      useAccountSubscription(
        mockConnection as unknown as import("@solana/web3.js").Connection,
        [key1],
        mockLoad,
        1000,
        "test-key",
      ),
    );

    await waitFor(() => {
      expect(mockConnection.getListenerCount()).toBe(1);
    });

    // Hide tab
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(mockConnection.getListenerCount()).toBe(0);
    });

    // Show tab again
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(mockConnection.getListenerCount()).toBe(1);
    });
  });

  it("calls refresh to reload data immediately", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValueOnce({ data: "initial" }).mockResolvedValueOnce({ data: "refreshed" });

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

    result.current.refresh();

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "ready", value: { data: "refreshed" } });
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

  it("restarts subscription when key prop changes", async () => {
    const key1 = new MockPublicKey("key1") as unknown as PublicKey;
    mockLoad.mockResolvedValue({ data: "test" });

    const { rerender } = renderHook(
      ({ keyProp }) =>
        useAccountSubscription(
          mockConnection as unknown as import("@solana/web3.js").Connection,
          [key1],
          mockLoad,
          1000,
          keyProp,
        ),
      { initialProps: { keyProp: "key-1" } },
    );

    await waitFor(() => {
      expect(mockLoad).toHaveBeenCalledTimes(1);
    });

    rerender({ keyProp: "key-2" });

    await waitFor(() => {
      expect(mockLoad).toHaveBeenCalledTimes(2);
    });
  });
});
