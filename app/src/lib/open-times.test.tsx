import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OPEN_TIMES_REFRESH_MS } from "./open-times-core";
import { useOpenTimes } from "./open-times";

const A = "MktA111111111111111111111111111111111111111";
const B = "MktB111111111111111111111111111111111111111";

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useOpenTimes (P1-4: fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads once for every market, then every minute", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ready: true, byMarket: { [A]: 100 } });
    const { result } = renderHook(() => useOpenTimes({ fetcher }));
    expect(result.current.status).toBe("loading");
    expect(result.current.openTime(A)).toBeNull();
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
    expect(result.current.openTime(A)).toBe(100);
    expect(result.current.openTime(B)).toBeNull();
    await tick(OPEN_TIMES_REFRESH_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("is unavailable, never a time, when the index cannot be read", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("open times could not be read (502)"));
    const { result } = renderHook(() => useOpenTimes({ fetcher }));
    await tick();
    expect(result.current.status).toBe("unavailable");
    expect(result.current.openTime(A)).toBe("unavailable");
  });

  it("keeps known times through a failed read and through a restarted (rebuilding) index", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ready: true, byMarket: { [A]: 100 } })
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ ready: false, byMarket: {} })
      .mockResolvedValueOnce({ ready: true, byMarket: { [B]: 200 } });
    const { result } = renderHook(() => useOpenTimes({ fetcher }));
    await tick();
    expect(result.current.openTime(A)).toBe(100);
    await tick(OPEN_TIMES_REFRESH_MS); // failed read
    expect(result.current.status).toBe("ready");
    expect(result.current.openTime(A)).toBe(100);
    await tick(OPEN_TIMES_REFRESH_MS); // the service restarted and is rebuilding
    expect(result.current.openTime(A)).toBe(100);
    expect(result.current.openTime(B)).toBe("unavailable");
    await tick(OPEN_TIMES_REFRESH_MS);
    expect(result.current.openTime(A)).toBe(100);
    expect(result.current.openTime(B)).toBe(200);
  });

  it("stops polling on unmount and skips a tick while a read is in flight", async () => {
    let release: (value: { ready: boolean; byMarket: Record<string, number> }) => void = () =>
      undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<{ ready: boolean; byMarket: Record<string, number> }>((resolve) => {
          release = resolve;
        }),
    );
    const { unmount } = renderHook(() => useOpenTimes({ fetcher, intervalMs: 1_000 }));
    await tick(3_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    release({ ready: true, byMarket: {} });
    unmount();
    await tick(5_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
