import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  approveState,
  availableAt,
  bpsText,
  money,
  sourceAge,
  withinSourceRange,
} from "./override-rules";
import { CLOSE, DELAY, draft, NVDA } from "./test-support";
import type { AppConfig } from "@/lib/chain";
import { market } from "@/test-utils";

const config: AppConfig = { paused: false, overrideDelaySecs: BigInt(DELAY), admin: "A" };

describe("approveState (UI-08 AC1)", () => {
  it("is disabled before close + delay and names the time in ET", () => {
    const state = approveState(NVDA, config, CLOSE + DELAY - 1);
    expect(state).toMatchObject({
      enabled: false,
      availability: "Override available at 17:00 ET (in 00:01)",
      reason: "Approve opens at 17:00 ET, 3600 s after the close.",
    });
  });

  it("is enabled exactly at close + delay and after", () => {
    expect(approveState(NVDA, config, CLOSE + DELAY)).toEqual({
      enabled: true,
      availability: "Override available now",
    });
    expect(approveState(NVDA, config, CLOSE + DELAY + 1).enabled).toBe(true);
    expect(approveState(NVDA, config, CLOSE + 10 * DELAY).enabled).toBe(true);
  });

  it("is 14:00 ET on an early-close day", () => {
    const early = market({ ...NVDA, closeTs: BigInt(CLOSE - 3 * 3600) });
    expect(approveState(early, config, CLOSE - 3 * 3600 + 60).availability).toMatch(
      /^Override available at 14:00 ET/,
    );
  });

  it("follows a changed override_delay_secs", () => {
    const short: AppConfig = { ...config, overrideDelaySecs: 1800n };
    expect(approveState(NVDA, short, CLOSE + 100).availability).toMatch(
      /^Override available at 16:30 ET/,
    );
    expect(approveState(NVDA, short, CLOSE + 1800).enabled).toBe(true);
    expect(availableAt(NVDA, short)).toBe(BigInt(CLOSE + 1800));
  });

  it("is never enabled for a settled or unknown market", () => {
    const settled = market({ ...NVDA, settled: true });
    expect(approveState(settled, config, CLOSE + 99 * DELAY)).toMatchObject({
      enabled: false,
      availability: "Already settled",
    });
    expect(approveState(undefined, config, CLOSE + 99 * DELAY)).toMatchObject({
      enabled: false,
      availability: "Unknown market",
    });
  });

  it("flips exactly at the boundary for any close and delay (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }),
        fc.integer({ min: 1, max: 86_400 }),
        (close, delay) => {
          const m = market({ ...NVDA, closeTs: BigInt(close) });
          const cfg: AppConfig = { ...config, overrideDelaySecs: BigInt(delay) };
          expect(approveState(m, cfg, close + delay - 1).enabled).toBe(false);
          expect(approveState(m, cfg, close + delay).enabled).toBe(true);
        },
      ),
    );
  });
});

describe("evidence wording", () => {
  it("shows a source's age", () => {
    const t = new Date((CLOSE + 300) * 1000).toISOString(); // 16:05:00 ET
    expect(sourceAge(t, CLOSE + 330)).toBe("as of 16:05:00 ET, 30 s old");
    expect(sourceAge(t, CLOSE + 300 + 180)).toBe("as of 16:05:00 ET, 3 min old");
    expect(sourceAge(t, CLOSE + 300 + 7300)).toBe("as of 16:05:00 ET, 2 h old");
    expect(sourceAge(t, CLOSE)).toBe("as of 16:05:00 ET, 0 s old"); // never negative
  });

  it("formats cents and basis points exactly", () => {
    expect(money(18_142)).toBe("$181.42");
    expect(money(100_000)).toBe("$1,000.00");
    expect(bpsText(2)).toBe("2 bps (0.02%)");
    expect(bpsText(5)).toBe("5 bps (0.05%)");
    expect(bpsText(150)).toBe("150 bps (1.50%)");
  });

  it("flags a proposed price outside the source range", () => {
    expect(withinSourceRange(draft())).toBe(true);
    expect(withinSourceRange(draft({ proposed_price_cents: 18_140 }))).toBe(true);
    expect(withinSourceRange(draft({ proposed_price_cents: 18_139 }))).toBe(false);
    expect(withinSourceRange(draft({ proposed_price_cents: 18_145 }))).toBe(false);
  });
});
