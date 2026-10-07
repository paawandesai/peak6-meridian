import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parsePath, selectPath, type PathSegment } from "./jsonpath";

describe("parsePath", () => {
  it("parses the subset the feeds use", () => {
    expect(parsePath("$")).toEqual([]);
    expect(parsePath("$[0].close")).toEqual([0, "close"]);
    expect(parsePath("$.data['last price'][12]")).toEqual(["data", "last price", 12]);
  });

  it.each(["close", "$..close", "$[*]", "$.a[?(@.b)]", "$.1a"])("rejects %j", (path) => {
    expect(() => parsePath(path)).toThrow();
  });
});

describe("selectPath", () => {
  const tiingo = [{ date: "2026-10-05T00:00:00.000Z", close: 254.43 }];

  it("selects values and returns undefined for missing steps", () => {
    expect(selectPath(tiingo, "$[0].close")).toBe(254.43);
    expect(selectPath({ close: "254.43" }, "$.close")).toBe("254.43");
    expect(selectPath(tiingo, "$[1].close")).toBeUndefined();
    expect(selectPath(tiingo, "$.close")).toBeUndefined();
    expect(selectPath({ a: 1 }, "$[0]")).toBeUndefined();
    expect(selectPath({ a: 1 }, "$.a.b")).toBeUndefined();
    expect(selectPath({}, "$.constructor")).toBeUndefined();
  });

  it("finds a value placed at any generated path (property)", () => {
    const segment: fc.Arbitrary<PathSegment> = fc.oneof(
      fc.nat({ max: 5 }),
      fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,8}$/),
    );
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 6 }),
        fc.double({ noNaN: true }),
        (path, value) => {
          let document: unknown = value;
          for (const step of [...path].reverse()) {
            if (typeof step === "number") {
              const array: unknown[] = Array.from({ length: step + 1 }, () => null);
              array[step] = document;
              document = array;
            } else {
              document = { [step]: document };
            }
          }
          const text = `$${path.map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("")}`;
          expect(selectPath(document, text)).toBe(value);
        },
      ),
    );
  });
});
