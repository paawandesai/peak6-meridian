import { AnchorProvider, BorshInstructionCoder, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildTrade,
  complementCents,
  IntentError,
  noViewOfBook,
  yesPriceFor,
  type TradeAccounts,
} from "./intents";
import { marketAddresses } from "./pda";
import { createMeridianProgram, MERIDIAN_IDL } from "./program";

const program = createMeridianProgram(
  new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}),
);
const coder = new BorshInstructionCoder(MERIDIAN_IDL);
const accounts: TradeAccounts = {
  user: Keypair.generate().publicKey,
  userUsdc: Keypair.generate().publicKey,
  userYes: Keypair.generate().publicKey,
  userNo: Keypair.generate().publicKey,
  market: marketAddresses({ symbol: "META", tradingDate: 20_261_006, strikeCents: 68_000n }),
};

describe("intents", () => {
  it("maps each intent to its instruction (full mapping checks live in AB-18)", async () => {
    const cases = [
      ["BUY_YES", "place_order"],
      ["SELL_YES", "place_order"],
      ["BUY_NO", "buy_no"],
      ["SELL_NO", "sell_no"],
    ] as const;
    for (const [intent, name] of cases) {
      const instruction = await buildTrade({
        program,
        intent,
        kind: "ioc",
        priceCents: 40,
        qty: 3n,
        accounts,
      });
      expect(coder.decode(Buffer.from(instruction.data))?.name).toBe(name);
    }
  });

  it("complements prices and refuses out-of-range ones", () => {
    expect(complementCents(62)).toBe(38);
    expect(yesPriceFor("BUY_NO", 38)).toBe(62);
    expect(yesPriceFor("BUY_YES", 38)).toBe(38);
    expect(() => complementCents(0)).toThrow(IntentError);
    expect(() => yesPriceFor("SELL_NO", 100)).toThrow(IntentError);
  });

  it("noViewOfBook is its own inverse", () => {
    const order = fc.record({ price: fc.integer({ min: 1, max: 99 }), qty: fc.nat() });
    fc.assert(
      fc.property(fc.record({ bids: fc.array(order), asks: fc.array(order) }), (book) => {
        expect(noViewOfBook(noViewOfBook(book))).toEqual(book);
      }),
    );
  });
});
