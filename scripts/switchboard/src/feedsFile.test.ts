import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import type { CreatedFeed } from "./devnet";
import { SOURCES, TICKERS } from "./feeds";
import { feedsFileJson, parseFeedsFile } from "./feedsFile";

function created(skip?: { ticker: string; source: string }): CreatedFeed[] {
  return TICKERS.flatMap((ticker, t) =>
    SOURCES.map((source, s) => ({
      ticker,
      source,
      feed: Keypair.generate().publicKey.toBase58(),
      feedHash: String((t * 2 + s) % 10).repeat(64),
    })),
  ).filter((c) => !(c.ticker === skip?.ticker && c.source === skip.source));
}

describe("feedsFileJson / parseFeedsFile", () => {
  it("writes all seven tickers, Tiingo first, and reads them back", () => {
    const feeds = created();
    const parsed = parseFeedsFile(feedsFileJson(feeds));
    expect(Object.keys(parsed)).toEqual([...TICKERS]);
    for (const ticker of TICKERS) {
      const [a, b] = parsed[ticker];
      expect(a.pubkey).toBe(feeds.find((f) => f.ticker === ticker && f.source === "tiingo")?.feed);
      expect(b.pubkey).toBe(
        feeds.find((f) => f.ticker === ticker && f.source === "twelvedata")?.feed,
      );
      expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses to write a partial file", () => {
    expect(() => feedsFileJson(created({ ticker: "META", source: "twelvedata" }))).toThrow(
      /no twelvedata feed was created for META/,
    );
  });

  it("rejects malformed files without echoing their content", () => {
    const good = JSON.parse(feedsFileJson(created())) as Record<
      string,
      { pubkey: string; hash: string }[]
    >;
    expect(() => parseFeedsFile("not json")).toThrow(/not JSON/);
    expect(() => parseFeedsFile("{}")).toThrow(/invalid/);
    const badHash = structuredClone(good);
    (badHash["META"] as { pubkey: string; hash: string }[])[0] = {
      pubkey: Keypair.generate().publicKey.toBase58(),
      hash: "XYZ-SECRET",
    };
    expect(() => parseFeedsFile(JSON.stringify(badHash))).toThrow(/META/);
    try {
      parseFeedsFile(JSON.stringify(badHash));
    } catch (error) {
      expect(String(error)).not.toContain("XYZ-SECRET");
    }
    const badKey = structuredClone(good);
    (badKey["AAPL"] as unknown[])[1] = { pubkey: "nope", hash: "a".repeat(64) };
    expect(() => parseFeedsFile(JSON.stringify(badKey))).toThrow(/base58/);
    expect(() => parseFeedsFile(JSON.stringify({ ...good, EXTRA: [] }))).toThrow(/invalid/);
  });
});
