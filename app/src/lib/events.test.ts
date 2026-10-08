import { describe, expect, it } from "vitest";

import { decodeEvents, type MeridianEvent, WALLET_EVENT_KINDS } from "./events";
import fixture from "./fixtures/events.json";

const context = { signature: fixture.signature, blockTime: fixture.blockTime };

function byKind<K extends MeridianEvent["kind"]>(
  events: readonly MeridianEvent[],
  kind: K,
): Extract<MeridianEvent, { kind: K }> {
  const found = events.find((event) => event.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} event decoded`);
  return found as Extract<MeridianEvent, { kind: K }>;
}

describe("decodeEvents (recorded fixture)", () => {
  const events = decodeEvents(fixture.logs, context, fixture.programId);

  it("decodes every wallet event type, in log order", () => {
    expect(events.map((event) => event.kind)).toEqual([
      "MarketCreated",
      "PairsMinted",
      "OrderPlaced",
      "Fill",
      "OrderCancelled",
      "FundsSettled",
      "MarketSettled",
      "Redeemed",
    ]);
    expect(new Set(events.map((event) => event.kind))).toEqual(new Set(WALLET_EVENT_KINDS));
  });

  it("carries the transaction signature and block time on every event", () => {
    for (const event of events) {
      expect(event.signature).toBe(fixture.signature);
      expect(event.blockTime).toBe(fixture.blockTime);
    }
  });

  it("returns typed fields: bigint quantities, integer-cent prices, sides", () => {
    expect(byKind(events, "Fill")).toMatchObject({
      price: 60,
      qty: 10n,
      takerSide: "Bid",
    });
    expect(byKind(events, "OrderPlaced")).toMatchObject({
      side: "Ask",
      price: 60,
      qty: 10n,
      restedQty: 10n,
      orderId: 7n,
    });
    expect(byKind(events, "OrderCancelled")).toMatchObject({ orderId: 8n, qty: 5n });
    expect(byKind(events, "PairsMinted")).toMatchObject({ qty: 20n, pairsOutstanding: 20n });
    expect(byKind(events, "Redeemed")).toMatchObject({ yesQty: 10n, noQty: 0n, usdc: 10_000_000n });
    expect(byKind(events, "FundsSettled")).toMatchObject({ usdc: 0n, yes: 10n });
    expect(byKind(events, "MarketCreated")).toMatchObject({
      ticker: "AAPL",
      strikeCents: 23_000n,
      tradingDate: 20261008,
      closeTs: 1_791_492_000n,
    });
    expect(byKind(events, "MarketSettled")).toMatchObject({ outcome: "Yes", oracleSlot: 321n });
    const fill = byKind(events, "Fill");
    expect(typeof fill.market).toBe("string");
    expect(fill.market).toBe(byKind(events, "OrderPlaced").market);
  });

  it("defaults the block time to null", () => {
    const [first] = decodeEvents(fixture.logs, { signature: "sig" }, fixture.programId);
    expect(first?.blockTime).toBeNull();
  });
});

describe("decodeEvents (bad input is skipped, never thrown)", () => {
  const dataLines = fixture.logs.filter((line) => line.startsWith("Program data: "));
  const first = dataLines[0] ?? "";
  const second = dataLines[1] ?? "";

  it("skips an unknown event discriminator", () => {
    const unknown = `Program data: ${Buffer.alloc(40, 7).toString("base64")}`;
    const logs = [`Program ${fixture.programId} invoke [1]`, unknown, first];
    expect(decodeEvents(logs, context, fixture.programId).map((e) => e.kind)).toEqual([
      "MarketCreated",
    ]);
  });

  it("skips a truncated event body and does not throw", () => {
    const truncated = `Program data: ${Buffer.from(second.slice("Program data: ".length), "base64").subarray(0, 12).toString("base64")}`;
    expect(() => decodeEvents([truncated], context, fixture.programId)).not.toThrow();
    expect(decodeEvents([truncated], context, fixture.programId)).toEqual([]);
  });

  it("skips non-base64 data and unrelated log lines", () => {
    const logs = [
      `Program ${fixture.programId} invoke [1]`,
      "Program data: !!!not base64!!!",
      "Program log: hello",
      first,
    ];
    expect(() => decodeEvents(logs, context, fixture.programId)).not.toThrow();
    expect(decodeEvents(logs, context, fixture.programId).map((e) => e.kind)).toEqual([
      "MarketCreated",
    ]);
    expect(decodeEvents([], context, fixture.programId)).toEqual([]);
  });

  it("ignores events from another program", () => {
    const other = "11111111111111111111111111111111";
    const logs = [`Program ${other} invoke [1]`, first, `Program ${other} success`];
    expect(decodeEvents(logs, context, fixture.programId)).toEqual([]);
  });

  it("keeps the valid events after a truncated one in the same transaction", () => {
    const body = Buffer.from(second.slice("Program data: ".length), "base64");
    const truncated = `Program data: ${body.subarray(0, 12).toString("base64")}`;
    const logs = [`Program ${fixture.programId} invoke [1]`, first, truncated, dataLines[2] ?? ""];
    const kinds = decodeEvents(logs, context, fixture.programId).map((event) => event.kind);
    expect(kinds).toEqual(["MarketCreated", "OrderPlaced"]);
  });

  it("keeps events decoded before a malformed one", () => {
    const logs = [`Program ${fixture.programId} invoke [1]`, first, "Program data: ====", second];
    const kinds = decodeEvents(logs, context, fixture.programId).map((event) => event.kind);
    expect(kinds).toEqual(["MarketCreated", "PairsMinted"]);
  });
});
