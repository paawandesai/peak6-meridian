import { describe, expect, it } from "vitest";

import { soonestOpenClose } from "./ticker-ladder";
import { market } from "@/test-utils";

describe("soonestOpenClose", () => {
  const now = 1_000;
  it("uses the soonest close among open markets, ignoring closed ones", () => {
    const rows = [
      market({ address: "a", closeTs: 500n }),
      market({ address: "b", closeTs: 3_000n }),
      market({ address: "c", closeTs: 2_000n }),
    ];
    expect(soonestOpenClose(rows, now)).toBe(2_000n);
  });
  it("falls back to the earliest close when none are open", () => {
    const rows = [market({ address: "a", closeTs: 900n }), market({ address: "b", closeTs: 500n })];
    expect(soonestOpenClose(rows, now)).toBe(500n);
  });
});
