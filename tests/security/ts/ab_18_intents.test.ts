// AB-18: the frontend must not map an intent to the wrong instruction or side (Buy NO sending a
// YES buy, Sell NO sending a sell of YES). Every one of the four intents is built into a real
// instruction, decoded from its bytes and checked against the table in docs/domain.md
// § The four trade paths; `noViewOfBook` is an exact inverse (p ↔ 100 − p, sides swapped).
import { AnchorProvider, type BN, BorshInstructionCoder, Wallet } from "@coral-xyz/anchor";
import {
  buildTrade,
  complementCents,
  createMeridianProgram,
  type Intent,
  INTENT_INSTRUCTION,
  marketAddresses,
  MERIDIAN_IDL,
  MERIDIAN_PROGRAM_ID,
  noViewOfBook,
  type OrderKindName,
  yesPriceFor,
} from "@meridian/client";
import { Connection, Keypair, type TransactionInstruction } from "@solana/web3.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

const program = createMeridianProgram(
  // No RPC call is ever made: building instructions is local.
  new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}),
);
const coder = new BorshInstructionCoder(MERIDIAN_IDL);
const market = marketAddresses({
  symbol: "META",
  tradingDate: 20_261_006,
  strikeCents: 68_000n,
});
const accounts = {
  user: Keypair.generate().publicKey,
  userUsdc: Keypair.generate().publicKey,
  userYes: Keypair.generate().publicKey,
  userNo: Keypair.generate().publicKey,
  market,
};
const INTENTS: readonly Intent[] = ["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"];

type Decoded = {
  name: string;
  data: { side?: object; price: number; qty: BN; kind?: object };
};

async function build(intent: Intent, kind: OrderKindName, priceCents: number, qty = 7n) {
  const instruction = await buildTrade({ program, intent, kind, priceCents, qty, accounts });
  const decoded = coder.decode(Buffer.from(instruction.data)) as Decoded | null;
  if (decoded === null) {
    throw new Error("instruction does not decode");
  }
  return { instruction, decoded };
}

/** The variant name of a decoded Anchor enum, lower-cased: `{ Bid: {} }` → `bid`. */
function variant(value: object | undefined): string | undefined {
  return value === undefined ? undefined : Object.keys(value)[0]?.toLowerCase();
}

function accountKeys(instruction: TransactionInstruction): string[] {
  return instruction.keys.map((key) => key.pubkey.toBase58());
}

describe("AB-18 intent → instruction mapping", () => {
  it("BUY_YES is a place_order bid at the YES price", async () => {
    const { instruction, decoded } = await build("BUY_YES", "limit", 62);
    expect(instruction.programId.equals(MERIDIAN_PROGRAM_ID)).toBe(true);
    expect(decoded.name).toBe("place_order");
    expect(variant(decoded.data.side)).toBe("bid");
    expect(decoded.data.price).toBe(62);
    expect(decoded.data.qty.toString()).toBe("7");
    expect(variant(decoded.data.kind)).toBe("limit");
  });

  it("SELL_YES is a place_order ask at the YES price", async () => {
    const { decoded } = await build("SELL_YES", "ioc", 38);
    expect(decoded.name).toBe("place_order");
    expect(variant(decoded.data.side)).toBe("ask");
    expect(decoded.data.price).toBe(38);
    expect(variant(decoded.data.kind)).toBe("ioc");
  });

  it("BUY_NO is buy_no with the YES floor 100 − NO price (never a YES buy)", async () => {
    const limit = await build("BUY_NO", "limit", 30);
    expect(limit.decoded.name).toBe("buy_no");
    expect(limit.decoded.data.price).toBe(70);
    expect(variant(limit.decoded.data.kind)).toBe("limit");
    expect(limit.decoded.data.side).toBeUndefined();
    const market99 = await build("BUY_NO", "ioc", 99);
    expect(market99.decoded.data.price).toBe(1);
    expect(variant(market99.decoded.data.kind)).toBe("ioc");
  });

  it("SELL_NO is sell_no with the YES cap 100 − NO price (never a YES sell)", async () => {
    const { decoded } = await build("SELL_NO", "ioc", 1);
    expect(decoded.name).toBe("sell_no");
    expect(decoded.data.price).toBe(99);
    expect(decoded.data.qty.toString()).toBe("7");
    expect(decoded.data.kind).toBeUndefined();
  });

  it("the intent table agrees with what is built", async () => {
    for (const intent of INTENTS) {
      const { decoded } = await build(intent, "ioc", 50);
      const expected = INTENT_INSTRUCTION[intent];
      expect(decoded.name).toBe(expected.instruction);
    }
    expect(INTENT_INSTRUCTION.BUY_NO.side).toBe("ask");
    expect(INTENT_INSTRUCTION.SELL_NO.side).toBe("bid");
  });

  it("SELL_NO is IOC only, NO intents need the NO account, and bad inputs are refused", async () => {
    await expect(build("SELL_NO", "limit", 50)).rejects.toThrow(/immediate-or-cancel/);
    for (const intent of ["BUY_NO", "SELL_NO"] as const) {
      await expect(
        buildTrade({
          program,
          intent,
          kind: "ioc",
          priceCents: 50,
          qty: 1n,
          accounts: { ...accounts, userNo: undefined },
        }),
      ).rejects.toThrow(/NO token account/);
    }
    for (const priceCents of [0, 100, -1, 50.5, Number.NaN]) {
      await expect(build("BUY_YES", "limit", priceCents)).rejects.toThrow(/price/);
    }
    await expect(build("BUY_YES", "limit", 50, 0n)).rejects.toThrow(/quantity/);
  });

  it("names the signer and the maker accounts the program expects", async () => {
    const maker = Keypair.generate().publicKey;
    for (const intent of INTENTS) {
      const instruction = await buildTrade({
        program,
        intent,
        kind: "ioc",
        priceCents: 50,
        qty: 1n,
        accounts,
        makers: [maker],
      });
      const signers = instruction.keys.filter((key) => key.isSigner);
      expect(signers.map((key) => key.pubkey.toBase58())).toEqual([accounts.user.toBase58()]);
      const last = instruction.keys[instruction.keys.length - 1];
      expect(last?.isWritable).toBe(true);
      expect(accountKeys(instruction)).toContain(market.escrowYes.toBase58());
      expect(accountKeys(instruction)).toContain(accounts.userYes.toBase58());
    }
  });
});

describe("AB-18 price transforms", () => {
  const price = fc.integer({ min: 1, max: 99 });

  it("YES intents keep the price, NO intents send 100 − price", () => {
    fc.assert(
      fc.property(price, (p) => {
        expect(yesPriceFor("BUY_YES", p)).toBe(p);
        expect(yesPriceFor("SELL_YES", p)).toBe(p);
        expect(yesPriceFor("BUY_NO", p)).toBe(100 - p);
        expect(yesPriceFor("SELL_NO", p)).toBe(100 - p);
        expect(complementCents(complementCents(p))).toBe(p);
      }),
    );
  });

  it("every built instruction carries exactly the transformed price", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...INTENTS),
        price,
        fc.constantFrom<OrderKindName>("limit", "ioc"),
        async (intent, p, kind) => {
          const k = intent === "SELL_NO" ? "ioc" : kind;
          const { decoded } = await build(intent, k, p);
          expect(decoded.data.price).toBe(yesPriceFor(intent, p));
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("AB-18 noViewOfBook", () => {
  const order = fc.record({
    price: fc.integer({ min: 1, max: 99 }),
    qty: fc.bigInt({ min: 1n, max: 1_000n }),
  });
  const book = fc.record({
    bids: fc.array(order, { maxLength: 12 }),
    asks: fc.array(order, { maxLength: 12 }),
  });

  it("is an exact inverse: applying it twice returns the original book", () => {
    fc.assert(
      fc.property(book, (b) => {
        expect(noViewOfBook(noViewOfBook(b))).toEqual(b);
      }),
    );
  });

  it("maps price p to 100 − p with the sides swapped and quantities untouched", () => {
    fc.assert(
      fc.property(book, (b) => {
        const view = noViewOfBook(b);
        expect(view.bids).toEqual(b.asks.map((o) => ({ ...o, price: 100 - o.price })));
        expect(view.asks).toEqual(b.bids.map((o) => ({ ...o, price: 100 - o.price })));
      }),
    );
  });

  it("keeps best-first order: the best YES ask becomes the best NO bid", () => {
    const view = noViewOfBook({
      bids: [
        { price: 62, qty: 1n },
        { price: 60, qty: 1n },
      ],
      asks: [
        { price: 65, qty: 1n },
        { price: 70, qty: 1n },
      ],
    });
    expect(view.bids.map((o) => o.price)).toEqual([35, 30]);
    expect(view.asks.map((o) => o.price)).toEqual([38, 40]);
  });

  it("rejects prices outside 1–99", () => {
    expect(() => noViewOfBook({ bids: [{ price: 0, qty: 1n }], asks: [] })).toThrow(/price/);
  });
});
