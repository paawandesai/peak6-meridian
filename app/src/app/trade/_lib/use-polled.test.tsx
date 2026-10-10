import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePolled } from "./use-polled";
import type { LiveRead, LiveSource } from "@/lib/account-feed";
import { setVisibility } from "@/lib/account-test-support";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
});

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("usePolled: polling", () => {
  it("loads now and every interval", async () => {
    const load = vi.fn().mockResolvedValue(1);
    const { result } = renderHook(() => usePolled(load, 1_000, "k"));
    expect(result.current.state).toEqual({ status: "loading" });
    await flush();
    expect(result.current.state).toEqual({ status: "ready", value: 1 });
    expect(result.current.live).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("keeps the last good value after a failure, and shows the first failure", async () => {
    const load = vi.fn().mockResolvedValue(5).mockRejectedValueOnce(new Error("down"));
    const { result } = renderHook(() => usePolled(load, 1_000, "k"));
    await flush();
    expect(result.current.state).toEqual({ status: "error", message: "down" });
    load.mockResolvedValueOnce(5).mockRejectedValueOnce("again");
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current.state).toEqual({ status: "ready", value: 5 });
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current.state).toEqual({ status: "ready", value: 5 });
  });

  it("skips ticks while the tab is hidden and reloads once when shown (P1-2)", async () => {
    const load = vi.fn().mockResolvedValue(1);
    renderHook(() => usePolled(load, 1_000, "k"));
    await flush();
    act(() => setVisibility("hidden"));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(load).toHaveBeenCalledTimes(1);
    act(() => setVisibility("visible"));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refresh reloads at once", async () => {
    const load = vi.fn().mockResolvedValue(1);
    const { result } = renderHook(() => usePolled(load, 60_000, "k"));
    await flush();
    act(() => result.current.refresh());
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

function fakeSource<T>() {
  let current: LiveRead<T> = { status: "loading" };
  let live = false;
  const listeners = new Set<() => void>();
  const refresh = vi.fn();
  const source: LiveSource<T> = {
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    read: () => current,
    isLive: () => live,
    refresh,
  };
  const set = (next: LiveRead<T>, nextLive = live) => {
    current = next;
    live = nextLive;
    for (const listener of [...listeners]) listener();
  };
  return { source, set, listeners, refresh };
}

describe("usePolled: live source (P1-2)", () => {
  it("never calls load: values come from the source as it pushes them", async () => {
    const load = vi.fn().mockResolvedValue(0);
    const fake = fakeSource<number>();
    const { result } = renderHook(() => usePolled(load, 1_000, "k", fake.source));
    expect(result.current.state).toEqual({ status: "loading" });
    act(() => fake.set({ status: "ready", value: 7 }, true));
    expect(result.current.state).toEqual({ status: "ready", value: 7 });
    expect(result.current.live).toBe(true);
    act(() => fake.set({ status: "ready", value: 8 }, false));
    expect(result.current.state).toEqual({ status: "ready", value: 8 });
    expect(result.current.live).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps the last good value when the source errors, and shows an error before any value", () => {
    const fake = fakeSource<number>();
    const { result } = renderHook(() =>
      usePolled(() => Promise.resolve(0), 1_000, "k", fake.source),
    );
    act(() => fake.set({ status: "error", message: "book account not found" }));
    expect(result.current.state).toEqual({ status: "error", message: "book account not found" });
    act(() => fake.set({ status: "ready", value: 1 }));
    act(() => fake.set({ status: "error", message: "429" }));
    expect(result.current.state).toEqual({ status: "ready", value: 1 });
  });

  it("refresh asks the source to read now", () => {
    const fake = fakeSource<number>();
    const { result } = renderHook(() =>
      usePolled(() => Promise.resolve(0), 1_000, "k", fake.source),
    );
    act(() => result.current.refresh());
    expect(fake.refresh).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on unmount and when the source changes", () => {
    const first = fakeSource<number>();
    const second = fakeSource<number>();
    const { rerender, unmount } = renderHook(
      ({ source }) => usePolled(() => Promise.resolve(0), 1_000, "k", source),
      { initialProps: { source: first.source } },
    );
    expect(first.listeners.size).toBe(1);
    rerender({ source: second.source });
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    unmount();
    expect(second.listeners.size).toBe(0);
  });
});
