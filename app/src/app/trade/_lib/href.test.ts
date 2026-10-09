import { describe, expect, it } from "vitest";

import { tradeHref } from "./href";
import { market } from "@/test-utils";

describe("tradeHref (UI-04 AC8)", () => {
  it("is /trade/ followed by exactly the market address", () => {
    for (const address of ["Mkt1", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"]) {
      expect(tradeHref(market({ address }))).toBe(`/trade/${address}`);
    }
  });
});
