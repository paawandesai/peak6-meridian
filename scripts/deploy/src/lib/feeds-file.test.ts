import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertHashesMatchDefinitions,
  bytesToHex,
  hexToBytes,
  parseFeedsFile,
  SOURCE_ORDER,
  TICKER_ORDER,
} from "./feeds-file";
import { feedsJson } from "./test-helpers";

describe("hex helpers", () => {
  it("round-trips arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
      }),
    );
  });

  it("rejects odd-length and non-hex strings", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
  });
});

describe("parseFeedsFile", () => {
  it("parses seven tickers with two feeds each", () => {
    const parsed = parseFeedsFile(JSON.stringify(feedsJson()));
    expect([...parsed.keys()]).toEqual([...TICKER_ORDER]);
    expect(parsed.get("AAPL")?.[1].hash).toHaveLength(32);
  });

  it("accepts upper-case hex and normalises it", () => {
    const json = feedsJson();
    const first = json.AAPL?.[0];
    if (first === undefined) throw new Error("fixture");
    first.hash = "AB".repeat(32);
    expect(
      bytesToHex(parseFeedsFile(JSON.stringify(json)).get("AAPL")?.[0].hash ?? new Uint8Array()),
    ).toBe("ab".repeat(32));
  });

  it("rejects non-JSON, a missing ticker, a short hash and a bad pubkey", () => {
    expect(() => parseFeedsFile("nope")).toThrow(/not JSON/);
    const missing = feedsJson();
    delete missing.TSLA;
    expect(() => parseFeedsFile(JSON.stringify(missing))).toThrow(/TSLA/);
    const shortHash = feedsJson();
    const feed = shortHash.META?.[0];
    if (feed === undefined) throw new Error("fixture");
    feed.hash = "ab";
    expect(() => parseFeedsFile(JSON.stringify(shortHash))).toThrow(/64 hex/);
    const badKey = feedsJson();
    const other = badKey.META?.[1];
    if (other === undefined) throw new Error("fixture");
    other.pubkey = "not-a-key";
    expect(() => parseFeedsFile(JSON.stringify(badKey))).toThrow(/base58/);
  });

  it("rejects an unknown extra ticker and a duplicated feed account", () => {
    expect(() => parseFeedsFile(JSON.stringify({ ...feedsJson(), NFLX: [] }))).toThrow();
    const dup = feedsJson();
    const a = dup.AAPL?.[0];
    const b = dup.MSFT?.[0];
    if (a === undefined || b === undefined) throw new Error("fixture");
    b.pubkey = a.pubkey;
    expect(() => parseFeedsFile(JSON.stringify(dup))).toThrow(/more than once/);
  });
});

describe("assertHashesMatchDefinitions", () => {
  const feeds = parseFeedsFile(JSON.stringify(feedsJson()));
  const expectedFor = (ticker: string, index: 0 | 1): string =>
    (TICKER_ORDER.indexOf(ticker as (typeof TICKER_ORDER)[number]) * 2 + index)
      .toString(16)
      .padStart(2, "0")
      .repeat(32);

  it("passes when every hash equals the computed one", () => {
    expect(() => assertHashesMatchDefinitions(feeds, expectedFor)).not.toThrow();
  });

  it("names each feed whose hash differs and says nothing was sent", () => {
    const wrong = (ticker: string, index: 0 | 1): string =>
      ticker === "NVDA" && index === 1 ? "ff".repeat(32) : expectedFor(ticker, index);
    expect(() => assertHashesMatchDefinitions(feeds, wrong as typeof expectedFor)).toThrow(
      new RegExp(`NVDA\\.${SOURCE_ORDER[1]}.*Nothing was sent`, "s"),
    );
  });
});
