import { act, renderHook } from "@testing-library/react";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ageSecs,
  asOfSecs,
  edgeCents,
  edgeText,
  edgeTone,
  edgeWord,
  formatAge,
  fairValueSchema,
  fairValuesSchema,
  fetchFairValues,
  type FairValue,
  FAIR_VALUES_PATH,
  isStale,
  REFRESH_MS,
  useFairValues,
} from "./fair-values";
import { fair, NOW } from "@/components/fair-value/test-support";
import { setVisibility } from "@/lib/account-test-support";

describe("edge (M3-03 AC1)", () => {
  it("is market − fair in integer cents, signed, with the word always written", () => {
    expect(edgeCents(62, 58)).toBe(4);
    expect(edgeText(4)).toBe("Edge +4¢ (rich)");
    expect(edgeCents(55, 58)).toBe(-3);
    expect(edgeText(-3)).toBe("Edge −3¢ (cheap)");
    expect(edgeCents(58, 58)).toBe(0);
    expect(edgeText(0)).toBe("Edge 0¢ (fair)");
  });

  it("uses the minus sign character, never a hyphen", () => {
    expect(edgeText(-1)).toContain("−");
    expect(edgeText(-1)).not.toContain("-");
  });

  it("always names rich, cheap or fair consistent with the sign (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        (market, fairC) => {
          const edge = edgeCents(market, fairC);
          expect(Number.isInteger(edge)).toBe(true);
          expect(edgeWord(edge)).toBe(market > fairC ? "rich" : market < fairC ? "cheap" : "fair");
          expect(edgeText(edge)).toMatch(/\((rich|cheap|fair)\)$/);
          expect(edgeText(edge)).toContain(`${Math.abs(edge)}¢`);
        },
      ),
    );
  });
});

describe("edgeTone (P0-FV: colour by side, the word still written)", () => {
  it("is the YES colour for cheap, NO for rich, neutral at fair", () => {
    expect(edgeTone(-3)).toBe("yes");
    expect(edgeTone(4)).toBe("no");
    expect(edgeTone(0)).toBe("neutral");
  });

  it("agrees with the written word for every market and fair price (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 99 }),
        (market, fairC) => {
          const edge = edgeCents(market, fairC);
          const expected = { cheap: "yes", rich: "no", fair: "neutral" }[edgeWord(edge)];
          expect(edgeTone(edge)).toBe(expected);
          // Antisymmetric: swapping market and fair flips the sign and the side.
          expect(edgeCents(fairC, market) + edge).toBe(0);
        },
      ),
    );
  });
});

describe("fair value age (P0-FV stale tag)", () => {
  it("reads as_of in unix seconds", () => {
    expect(asOfSecs(fair({ as_of: new Date(NOW * 1000).toISOString() }))).toBe(NOW);
    expect(asOfSecs(fair({ as_of: "2026-10-08T14:00:00.900-04:00" }))).toBe(
      Math.floor(Date.parse("2026-10-08T18:00:00Z") / 1000),
    );
  });

  it("is never negative and rounds down", () => {
    expect(ageSecs(NOW, NOW - 5)).toBe(0);
    expect(ageSecs(NOW - 42, NOW + 0.9)).toBe(42);
  });

  it("formats seconds, minutes and hours in whole units, rounded down", () => {
    expect(formatAge(0)).toBe("0 s");
    expect(formatAge(59)).toBe("59 s");
    expect(formatAge(60)).toBe("1 min");
    expect(formatAge(3_599)).toBe("59 min");
    expect(formatAge(3_600)).toBe("1 h");
    expect(formatAge(7_300)).toBe("2 h");
  });
});

describe("fairValueSchema", () => {
  it("accepts the service shape, with spot as a string or a number", () => {
    expect(fairValueSchema.safeParse(fair()).success).toBe(true);
    expect(fairValueSchema.safeParse(fair({ spot: 181.42 })).success).toBe(true);
  });

  it.each([
    ["a fractional fair value", { fair_cents: 58.5 }],
    ["fair 0", { fair_cents: 0 }],
    ["fair 100", { fair_cents: 100 }],
    ["a negative strike", { strike_cents: -1 }],
    ["a bad time", { as_of: "soon" }],
    ["a non-boolean stale", { stale: "no" }],
    ["a spot that is not a number", { spot: "NaN" }],
  ])("rejects %s", (_name, patch) => {
    expect(fairValueSchema.safeParse({ ...fair(), ...patch }).success).toBe(false);
  });

  it("drops fields it does not know", () => {
    expect(fairValueSchema.parse({ ...fair(), api_key: "k" })).toEqual(fair());
  });

  it("limits the list size", () => {
    expect(fairValuesSchema.safeParse(Array.from({ length: 501 }, () => fair())).success).toBe(
      false,
    );
  });
});

describe("isStale (M3-03 AC2)", () => {
  it("is stale when the service says so", () => {
    expect(isStale(fair({ stale: true }), NOW)).toBe(true);
  });

  it("is stale when as_of is more than 10 s old, not at exactly 10 s", () => {
    expect(isStale(fair({ as_of: new Date((NOW - 10) * 1000).toISOString() }), NOW)).toBe(false);
    expect(isStale(fair({ as_of: new Date((NOW - 11) * 1000).toISOString() }), NOW)).toBe(true);
  });
});

describe("fetchFairValues", () => {
  const reply = (status: number, body: unknown) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("reads the proxy path with no caching", async () => {
    const fetcher = reply(200, [fair()]);
    expect(await fetchFairValues(fetcher)).toEqual([fair()]);
    expect(fetcher).toHaveBeenCalledWith(FAIR_VALUES_PATH, { cache: "no-store" });
  });

  it("says plainly when it is not configured or unreachable, and rejects a bad shape", async () => {
    await expect(fetchFairValues(reply(503, {}))).rejects.toThrow(/not configured/);
    await expect(fetchFairValues(reply(502, {}))).rejects.toThrow(/could not be read \(502\)/);
    await expect(fetchFairValues(reply(200, [{ x: 1 }]))).rejects.toThrow(/unexpected shape/);
  });
});

describe("useFairValues (M3-03 AC2: fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("reads at once and then every 5 s", async () => {
    const fetcher = vi.fn().mockResolvedValue([fair()]);
    const { result } = renderHook(() => useFairValues({ fetcher }));
    expect(result.current.status).toBe("loading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ status: "ready", refreshFailed: false });
    expect(result.current.byMarket[fair().market]?.fair_cents).toBe(58);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("skips reads while the tab is hidden (P1-2)", async () => {
    const fetcher = vi.fn().mockResolvedValue([fair()]);
    renderHook(() => useFairValues({ fetcher }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 4);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good values and marks the refresh failed when a read fails", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([fair()])
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue([fair({ fair_cents: 61 })]);
    const { result } = renderHook(() => useFairValues({ fetcher }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    expect(result.current.refreshFailed).toBe(true);
    expect(result.current.byMarket[fair().market]?.fair_cents).toBe(58);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    expect(result.current).toMatchObject({ status: "ready", refreshFailed: false });
    expect(result.current.byMarket[fair().market]?.fair_cents).toBe(61);
  });

  it("is unavailable, with no numbers, when nothing was ever read", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useFairValues({ fetcher }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual({ status: "unavailable", byMarket: {}, refreshFailed: true });
  });

  it("does not read while disabled, and stops reading on unmount", async () => {
    const fetcher = vi.fn().mockResolvedValue([fair()]);
    const off = renderHook(() => useFairValues({ fetcher, enabled: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 2);
    });
    expect(fetcher).not.toHaveBeenCalled();
    off.unmount();
    const on = renderHook(() => useFairValues({ fetcher }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    on.unmount();
    const calls = fetcher.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    });
    expect(fetcher.mock.calls.length).toBe(calls);
  });

  it("skips a tick while the previous read is still in flight", async () => {
    let release: (values: FairValue[]) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<FairValue[]>((resolve) => void (release = resolve)));
    renderHook(() => useFairValues({ fetcher }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      release([fair()]);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
