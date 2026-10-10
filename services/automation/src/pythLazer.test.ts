import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  checkSignedClose,
  confidenceBps,
  fetchSignedPrice,
  type HttpPost,
  parsePythPayload,
  parseSolanaMessage,
  priceCents,
  PYTH_CHANNEL,
  PYTH_FEED_IDS,
  signatureIsValid,
  type CloseRules,
} from "./pythLazer";
import { encodePythPayload, pythTestSigner, signedPythUpdate, signPythMessage } from "./testing";

/** Flips the low bit of one byte. */
const flip = (bytes: Uint8Array, at: number): void => {
  bytes[at] = (bytes[at] ?? 0) ^ 1;
};

const CLOSE = 1_791_576_000; // 2026-10-09 16:00 ET
const AAPL = 922;
const signer = pythTestSigner();
// $254.12 with 8 fractional digits; confidence $0.05 ≈ 1.97 bps.
const PRICE = 25_412_000_000n;
const CONF = 5_000_000n;

function rules(overrides: Partial<CloseRules> = {}): CloseRules {
  return {
    signer: signer.publicKey.toBytes(),
    feedId: AAPL,
    closeTs: CLOSE,
    closeWindowSecs: 60,
    maxConfBps: 5,
    nowSecs: CLOSE + 300,
    ...overrides,
  };
}

const atClose = (extra: Partial<Parameters<typeof signedPythUpdate>[1]> = {}) =>
  signedPythUpdate(signer, {
    feedId: AAPL,
    timestampUs: BigInt(CLOSE) * 1_000_000n,
    price: PRICE,
    confidence: CONF,
    ...extra,
  });

describe("parsePythPayload (wire format, pyth-lazer-protocol v0.46.0)", () => {
  it("round-trips any single-feed Price/Exponent/Confidence payload", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
        fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).filter((p) => p !== 0n),
        fc.integer({ min: -32_768, max: 32_767 }),
        fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
        (feedId, timestampUs, price, exponent, confidence) => {
          const parsed = parsePythPayload(
            encodePythPayload({ feedId, timestampUs, price, exponent, confidence }),
          );
          expect(parsed).toEqual({
            timestampUs,
            channel: 2,
            feedId,
            price,
            exponent,
            confidence: confidence === 0n ? null : confidence,
          });
        },
      ),
    );
  });

  const base = (): Buffer =>
    Buffer.from(encodePythPayload({ feedId: AAPL, timestampUs: 1n, price: 1n, confidence: 1n }));

  it("rejects a wrong magic, a truncation, extra feeds and trailing bytes", () => {
    const magic = base();
    magic[0] = 0;
    expect(() => parsePythPayload(magic)).toThrow(/magic/);
    expect(() => parsePythPayload(base().subarray(0, 20))).toThrow(/truncated/);
    const twoFeeds = base();
    twoFeeds[13] = 2;
    expect(() => parsePythPayload(twoFeeds)).toThrow(/exactly one feed/);
    expect(() => parsePythPayload(Buffer.concat([base(), Buffer.from([0])]))).toThrow(/trailing/);
  });

  it("rejects unrequested and repeated properties, a zero price and a missing exponent", () => {
    const unknown = base();
    unknown[19] = 3; // PublisherCount instead of Price
    expect(() => parsePythPayload(unknown)).toThrow(/not one settlement requests/);
    const repeated = base();
    repeated[31] = 0; // Confidence slot relabelled as a second Price
    expect(() => parsePythPayload(repeated)).toThrow(/repeated/);
    expect(() =>
      parsePythPayload(encodePythPayload({ feedId: 1, timestampUs: 1n, price: 0n })),
    ).toThrow(/no price/);
    const noExponent = Buffer.from(
      encodePythPayload({ feedId: 1, timestampUs: 1n, price: 1n, confidence: 1n }),
    );
    noExponent[28] = 5; // Exponent relabelled as Confidence: no exponent left, Confidence twice
    expect(() => parsePythPayload(noExponent)).toThrow();
  });

  it("an absent confidence (0 on the wire) or a missing property reads as null", () => {
    expect(atClose({ confidence: 0n }).parsed.confidence).toBeNull();
    const omitted = parsePythPayload(encodePythPayload({ feedId: 1, timestampUs: 1n, price: 7n }));
    expect(omitted.confidence).toBeNull();
  });
});

describe("parseSolanaMessage and the signature", () => {
  it("decodes the envelope and verifies Pyth's Ed25519 signature over the payload", () => {
    const update = atClose();
    expect(Buffer.from(update.publicKey).equals(signer.publicKey.toBuffer())).toBe(true);
    expect(signatureIsValid(update)).toBe(true);
    const flipped = Uint8Array.from(update.payload);
    flip(flipped, flipped.length - 1);
    expect(signatureIsValid({ ...update, payload: flipped })).toBe(false);
  });

  it("rejects another format and a length that disagrees with the payload", () => {
    const message = signPythMessage(
      signer,
      encodePythPayload({ feedId: 1, timestampUs: 1n, price: 1n }),
    );
    const evm = Uint8Array.from(message);
    evm[0] = 0;
    expect(() => parseSolanaMessage(evm)).toThrow(/solana format/);
    expect(() => parseSolanaMessage(Uint8Array.from([...message, 0]))).toThrow(/length/);
  });
});

describe("checkSignedClose: the settle_market rules, off-chain", () => {
  it("accepts the update taken at close with a tight confidence, settled any time later", () => {
    expect(() => checkSignedClose(atClose(), rules())).not.toThrow();
    expect(() => checkSignedClose(atClose(), rules({ nowSecs: CLOSE + 86_400 }))).not.toThrow();
  });

  it("rejects a wrong signer and a broken signature", () => {
    const other = pythTestSigner();
    expect(() => checkSignedClose(atClose(), rules({ signer: other.publicKey.toBytes() }))).toThrow(
      /pinned pyth_lazer_signer/,
    );
    const update = atClose();
    const signature = Uint8Array.from(update.signature);
    flip(signature, 0);
    const forged = { ...update, signature };
    expect(() => checkSignedClose(forged, rules())).toThrow(/signature is invalid/);
  });

  it("rejects a wrong feed", () => {
    expect(() => checkSignedClose(atClose({ feedId: PYTH_FEED_IDS.TSLA }), rules())).toThrow(
      /feed 1435 is not the pinned 922/,
    );
  });

  it("rejects a pre-close, a post-window and a future timestamp", () => {
    const us = (s: number): bigint => BigInt(s) * 1_000_000n;
    expect(() => checkSignedClose(atClose({ timestampUs: us(CLOSE) - 1n }), rules())).toThrow(
      /before close/,
    );
    expect(() => checkSignedClose(atClose({ timestampUs: us(CLOSE + 61) }), rules())).toThrow(
      /after the close window/,
    );
    expect(() => checkSignedClose(atClose({ timestampUs: us(CLOSE + 60) }), rules())).not.toThrow();
    expect(() =>
      checkSignedClose(atClose({ timestampUs: us(CLOSE + 30) }), rules({ nowSecs: CLOSE + 10 })),
    ).toThrow(/future/);
  });

  it("rejects a confidence wider than max_conf_bps, and none at all", () => {
    // 5 bps of 25_412_000_000 is exactly 12_706_000.
    expect(() => checkSignedClose(atClose({ confidence: 12_706_000n }), rules())).not.toThrow();
    expect(() => checkSignedClose(atClose({ confidence: 12_706_001n }), rules())).toThrow(
      /wider than 5 bps/,
    );
    expect(() => checkSignedClose(atClose({ confidence: 0n }), rules())).toThrow(/no confidence/);
  });

  it("the confidence rule matches exact rational arithmetic", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 14n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.integer({ min: 1, max: 10_000 }),
        (price, confidence, maxConfBps) => {
          const update = atClose({ price, confidence });
          const ok = confidence * 10_000n <= price * BigInt(maxConfBps);
          const run = () => checkSignedClose(update, rules({ maxConfBps }));
          if (ok) {
            expect(run).not.toThrow();
          } else {
            expect(run).toThrow(/wider than/);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("priceCents and confidenceBps", () => {
  it("converts mantissas to integer cents, rounding half away from zero", () => {
    expect(priceCents(atClose().parsed)).toBe(25_412n);
    expect(priceCents(atClose({ price: 25_412_500_000n }).parsed)).toBe(25_413n);
    expect(priceCents(atClose({ price: 25_412_499_999n }).parsed)).toBe(25_412n);
    expect(priceCents(atClose({ price: 7n, exponent: 0 }).parsed)).toBe(700n);
    expect(confidenceBps(atClose().parsed)).toBeCloseTo(1.96, 2);
    expect(confidenceBps(atClose({ confidence: 0n }).parsed)).toBe(Number.POSITIVE_INFINITY);
  });

  it("matches a decimal division for any 8-digit price", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 13n }), (price) => {
        const exact = Number(price) / 1e6;
        const cents = Number(priceCents(atClose({ price }).parsed));
        expect(Math.abs(cents - exact)).toBeLessThanOrEqual(0.5);
      }),
    );
  });
});

describe("fetchSignedPrice (Pyth Lazer REST, no network)", () => {
  const TOKEN = "secret-pyth-token-1234";
  const message = signPythMessage(
    signer,
    encodePythPayload({
      feedId: AAPL,
      timestampUs: BigInt(CLOSE) * 1_000_000n,
      price: PRICE,
      confidence: CONF,
    }),
  );

  function replying(status: number, body: unknown, seen: unknown[] = []): HttpPost {
    return (url, init) => {
      seen.push({ url, init });
      return Promise.resolve({ status, json: () => Promise.resolve(body) });
    };
  }

  const params = (post: HttpPost) => ({
    post,
    token: TOKEN,
    baseUrl: "https://lazer.test",
    feedId: AAPL,
    timestampUs: BigInt(CLOSE) * 1_000_000n,
  });

  it("asks for the solana update at the timestamp with a bearer token and decodes it", async () => {
    const seen: { url: string; init: Parameters<HttpPost>[1] }[] = [];
    const hex = Buffer.from(message).toString("hex");
    const update = await fetchSignedPrice(
      params(replying(200, { solana: { encoding: "hex", data: hex } }, seen)),
    );
    expect(update.parsed.price).toBe(PRICE);
    expect(seen[0]?.url).toBe("https://lazer.test/v1/price");
    expect(seen[0]?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen[0]?.init.body ?? "{}")).toEqual({
      timestamp: CLOSE * 1_000_000,
      priceFeedIds: [AAPL],
      properties: ["price", "exponent", "confidence"],
      formats: ["solana"],
      channel: PYTH_CHANNEL,
      jsonBinaryEncoding: "hex",
      parsed: false,
    });
  });

  it("names the HTTP failure without ever echoing the token", async () => {
    for (const [status, hint] of [
      [404, /no update at that time/],
      [403, /not entitled/],
      [429, /rate limited/],
      [500, /HTTP 500/],
    ] as const) {
      const run = fetchSignedPrice(params(replying(status, { error: TOKEN })));
      await expect(run).rejects.toThrow(hint);
      await expect(run).rejects.not.toThrow(TOKEN);
    }
    await expect(fetchSignedPrice(params(replying(200, { parsed: {} })))).rejects.toThrow(
      /no hex solana update/,
    );
  });

  it("times out", async () => {
    const hang: HttpPost = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(fetchSignedPrice({ ...params(hang), timeoutMs: 5 })).rejects.toThrow(/timed out/);
  });
});
