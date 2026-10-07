import { PublicKey } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  findBookPda,
  findConfigPda,
  findEscrowUsdcPda,
  findEscrowYesPda,
  findMarketPda,
  findNoMintPda,
  findOpenOrdersPda,
  findVaultPda,
  findYesMintPda,
  marketAddresses,
  SEEDS,
  symbolBytes,
  symbolFromBytes,
  u32Le,
  u64Le,
} from "./pda";
import { MERIDIAN_IDL, MERIDIAN_PROGRAM_ID } from "./program";

// Same inputs as programs/meridian/tests/pdas.rs; the addresses are the ones Rust derives
// from the seed constants in programs/meridian/src/state (M1-02 AC4).
const FIXTURE = { symbol: "META", tradingDate: 20261006, strikeCents: 68_000n };
const FIXTURE_OWNER = new PublicKey("11111111111111111111111111111112");
const EXPECTED = {
  config: "BTFSRpCGp83nQKfa54dxy3Zu1jX2T94aC2xdtqbVGLtx",
  market: "BGd5Y6qA5uT2zzgUzsZ3Mmw8m3Y8vJJLRWEybtDuU8im",
  yesMint: "5rsYKLySZ8TwEroxJrKZhLeG9qRLweMqjuMf7Z2Uyqcz",
  noMint: "Kpxnc7sKpyprQnjq3cBHkHVEFXgBJ8TcTQ671LK5Hf8",
  vault: "74tCuYxrAte59R2bCdbcJNcNYvMYYwJ37N4awkuuDsYG",
  escrowUsdc: "CTuFnW5wvESkenA3RMvZYvUmraF5bEhxm8cZeek2UycW",
  escrowYes: "5RaodcXqQVcGdfVMJHbN3i6FU4w7Lr5tf4ttcXVmMgv8",
  book: "HRC4F4DZaMAVY7wqr28E2m1QMLDgCeErJDvqLkwnZvvM",
  openOrders: "2huqHHnYVfv91styHC5oTgDQzez3vH6ebE5ggUpLE9pH",
};

const encoder = new TextEncoder();

describe("PDA fixtures shared with the Rust tests", () => {
  it("derives the same addresses as programs/meridian/tests/pdas.rs", () => {
    const addresses = marketAddresses(FIXTURE);
    const openOrders = findOpenOrdersPda(addresses.market, FIXTURE_OWNER).address;
    expect({
      config: findConfigPda().address.toBase58(),
      market: addresses.market.toBase58(),
      yesMint: addresses.yesMint.toBase58(),
      noMint: addresses.noMint.toBase58(),
      vault: addresses.vault.toBase58(),
      escrowUsdc: addresses.escrowUsdc.toBase58(),
      escrowYes: addresses.escrowYes.toBase58(),
      book: addresses.book.toBase58(),
      openOrders: openOrders.toBase58(),
    }).toEqual(EXPECTED);
  });

  it("uses the config seed the IDL declares for initialize_config", () => {
    const initialize = MERIDIAN_IDL.instructions.find((ix) => ix.name === "initialize_config");
    const config = initialize?.accounts.find((account) => account.name === "config");
    const seeds = config !== undefined && "pda" in config ? config.pda?.seeds : undefined;
    expect(seeds).toEqual([{ kind: "const", value: Array.from(encoder.encode(SEEDS.config)) }]);
  });
});

describe("seed layout (architecture.md § Data model)", () => {
  it('market = ["market", symbol(8, zero-padded), trading_date u32 LE, strike_cents u64 LE]', () => {
    const [expected, bump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        Buffer.from([0x4d, 0x45, 0x54, 0x41, 0, 0, 0, 0]),
        Buffer.from([0x8e, 0x28, 0x35, 0x01]), // 20261006 = 0x0135288e
        Buffer.from([0xa0, 0x09, 0x01, 0, 0, 0, 0, 0]), // 68000 = 0x109a0
      ],
      MERIDIAN_PROGRAM_ID,
    );
    expect(findMarketPda(FIXTURE)).toEqual({ address: expected, bump });
  });

  it.each([
    ["yes", findYesMintPda],
    ["no", findNoMintPda],
    ["vault", findVaultPda],
    ["escrow_usdc", findEscrowUsdcPda],
    ["escrow_yes", findEscrowYesPda],
    ["book", findBookPda],
  ] as const)("[%s, market]", (seed, derive) => {
    const market = PublicKey.unique();
    const [expected, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from(seed), market.toBuffer()],
      MERIDIAN_PROGRAM_ID,
    );
    expect(derive(market)).toEqual({ address: expected, bump });
  });

  it('open orders = ["oo", market, owner]', () => {
    const market = PublicKey.unique();
    const owner = PublicKey.unique();
    const [expected, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("oo"), market.toBuffer(), owner.toBuffer()],
      MERIDIAN_PROGRAM_ID,
    );
    expect(findOpenOrdersPda(market, owner)).toEqual({ address: expected, bump });
  });

  it("derives under another program ID when asked", () => {
    const other = PublicKey.unique();
    expect(findConfigPda(other).address).not.toEqual(findConfigPda().address);
    expect(findConfigPda(other).address).toEqual(
      PublicKey.findProgramAddressSync([Buffer.from("config")], other)[0],
    );
    expect(marketAddresses(FIXTURE, other).market).toEqual(findMarketPda(FIXTURE, other).address);
  });
});

describe("symbol and integer encodings", () => {
  it("zero-pads symbols to 8 bytes", () => {
    expect(symbolBytes("META")).toEqual(new Uint8Array([77, 69, 84, 65, 0, 0, 0, 0]));
    expect(symbolBytes("GOOGLABC")).toEqual(new Uint8Array([71, 79, 79, 71, 76, 65, 66, 67]));
  });

  it.each(["", "meta", "META1", "TOOLONGXX", "MÉTA", "ME TA"])("rejects symbol %j", (symbol) => {
    expect(() => symbolBytes(symbol)).toThrow(/upper-case ASCII/);
  });

  it("round-trips any valid symbol through the on-chain layout", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z]{1,8}$/), (symbol) => {
        const bytes = symbolBytes(symbol);
        return bytes.length === 8 && symbolFromBytes(bytes) === symbol;
      }),
    );
    expect(symbolFromBytes([65, 66, 67, 68, 69, 70, 71, 72])).toBe("ABCDEFGH");
  });

  it("encodes little-endian integers", () => {
    expect(u32Le(0x01353092)).toEqual(new Uint8Array([0x92, 0x30, 0x35, 0x01]));
    expect(u64Le(0x109a0n)).toEqual(new Uint8Array([0xa0, 0x09, 0x01, 0, 0, 0, 0, 0]));
    expect(u64Le(0xffff_ffff_ffff_ffffn)).toEqual(new Uint8Array(8).fill(0xff));
    expect(() => u32Le(-1)).toThrow(/u32/);
    expect(() => u32Le(2 ** 32)).toThrow(/u32/);
    expect(() => u32Le(1.5)).toThrow(/u32/);
    expect(() => u64Le(-1n)).toThrow(/u64/);
    expect(() => u64Le(2n ** 64n)).toThrow(/u64/);
  });

  it("rejects market keys with an invalid date or strike", () => {
    expect(() => findMarketPda({ ...FIXTURE, tradingDate: 20261306 })).toThrow(/calendar date/);
    expect(() => findMarketPda({ ...FIXTURE, strikeCents: 68_050n })).toThrow(/multiple of \$10/);
    expect(() => findMarketPda({ ...FIXTURE, strikeCents: 0n })).toThrow(/multiple of \$10/);
    expect(() => findMarketPda({ ...FIXTURE, symbol: "meta" })).toThrow(/upper-case ASCII/);
  });

  it("gives distinct markets for distinct keys", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z]{1,8}$/),
        fc.stringMatching(/^[A-Z]{1,8}$/),
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        (a, b, strikeA, strikeB) => {
          const keyA = { symbol: a, tradingDate: 20261006, strikeCents: BigInt(strikeA) * 1000n };
          const keyB = { symbol: b, tradingDate: 20261006, strikeCents: BigInt(strikeB) * 1000n };
          const same = a === b && strikeA === strikeB;
          return findMarketPda(keyA).address.equals(findMarketPda(keyB).address) === same;
        },
      ),
    );
  });
});
