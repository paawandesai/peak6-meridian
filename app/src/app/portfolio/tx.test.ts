// @vitest-environment node
import { AnchorProvider, BorshInstructionCoder } from "@coral-xyz/anchor";
import { createMeridianProgram, findOpenOrdersPda, MERIDIAN_IDL } from "@meridian/client";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { AAPL, NVDA } from "./fixtures";
import {
  addressesOf,
  buildRedeem,
  buildWithdraw,
  chunk,
  MARKETS_PER_TRANSACTION,
  redeemSlices,
} from "./tx";

const user = Keypair.generate().publicKey;
const usdcMint = Keypair.generate().publicKey;
const refuse = () => Promise.reject(new Error("never signs"));
const program = createMeridianProgram(
  new AnchorProvider(
    new Connection("http://127.0.0.1:1"),
    { publicKey: user, signTransaction: refuse, signAllTransactions: refuse },
    {},
  ),
);
const coder = new BorshInstructionCoder(MERIDIAN_IDL);
const ata = (mint: typeof usdcMint) => getAssociatedTokenAddressSync(mint, user);

describe("buildRedeem", () => {
  it("creates missing token accounts, then one redeem with the winner quantities (one transaction)", async () => {
    const a = addressesOf(AAPL, program.programId);
    const instructions = await buildRedeem({
      program,
      user,
      usdcMint,
      market: AAPL,
      yesQty: 40n,
      noQty: 3n,
    });
    expect(instructions).toHaveLength(4);
    for (const create of instructions.slice(0, 3)) {
      expect(create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    }
    const redeem = instructions[3];
    if (redeem === undefined) throw new Error("no redeem instruction");
    const decoded = coder.decode(redeem.data);
    expect(decoded?.name).toBe("redeem");
    expect(decoded?.data).toMatchObject({ yes_qty: expect.anything(), no_qty: expect.anything() });
    const data = decoded?.data as {
      yes_qty: { toString(): string };
      no_qty: { toString(): string };
    };
    expect([data.yes_qty.toString(), data.no_qty.toString()]).toEqual(["40", "3"]);
    // Accounts in IDL order: market, user (signer), user_usdc, user_yes, user_no, mints, vault, token.
    const keys = redeem.keys.map((key) => key.pubkey.toBase58());
    expect(keys).toEqual(
      [a.market, user, ata(usdcMint), ata(a.yesMint), ata(a.noMint), a.yesMint, a.noMint, a.vault]
        .map((key) => key.toBase58())
        .concat("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    );
    expect(redeem.keys[1]?.isSigner).toBe(true);
  });

  it("uses the wallet's existing token accounts and skips creating them", async () => {
    const yes = Keypair.generate().publicKey;
    const no = Keypair.generate().publicKey;
    const usdc = Keypair.generate().publicKey;
    const instructions = await buildRedeem({
      program,
      user,
      usdcMint,
      market: AAPL,
      yesQty: 1n,
      noQty: 1n,
      accounts: { usdc, yes, no },
    });
    expect(instructions).toHaveLength(1); // only the redeem
    const keys = instructions.at(-1)?.keys.map((key) => key.pubkey.toBase58());
    expect(keys?.[2]).toBe(usdc.toBase58());
    expect(keys?.[3]).toBe(yes.toBase58());
    expect(keys?.[4]).toBe(no.toBase58());
  });

  it("refuses an unsettled market and an empty redemption", async () => {
    await expect(
      buildRedeem({ program, user, usdcMint, market: NVDA, yesQty: 1n, noQty: 0n }),
    ).rejects.toThrow(/settled/);
    await expect(
      buildRedeem({ program, user, usdcMint, market: AAPL, yesQty: 0n, noQty: 0n }),
    ).rejects.toThrow(/nothing to redeem/);
  });
});

describe("buildWithdraw", () => {
  it("is one settle_funds on the owner's OpenOrders, escrow and own token accounts", async () => {
    const a = addressesOf(NVDA, program.programId);
    const instructions = await buildWithdraw({ program, owner: user, usdcMint, market: NVDA });
    const settle = instructions.at(-1);
    if (settle === undefined) throw new Error("no instruction");
    expect(coder.decode(settle.data)?.name).toBe("settle_funds");
    const keys = settle.keys.map((key) => key.pubkey.toBase58());
    expect(keys.slice(0, 7)).toEqual(
      [
        a.market,
        user,
        findOpenOrdersPda(a.market, user, program.programId).address,
        a.escrowUsdc,
        a.escrowYes,
        ata(usdcMint),
        ata(a.yesMint),
      ].map((key) => key.toBase58()),
    );
  });
});

describe("chunk", () => {
  it("splits into transactions of at most MARKETS_PER_TRANSACTION", () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    expect(chunk(items).map((group) => group.length)).toEqual([MARKETS_PER_TRANSACTION, 3, 1]);
    expect(chunk([])).toEqual([]);
  });
});

describe("redeemSlices", () => {
  const acct = () => Keypair.generate().publicKey.toBase58();
  it("pairs accounts index by index and drops empty pairs", () => {
    const [y1, y2, n1] = [acct(), acct(), acct()];
    const slices = redeemSlices(
      [
        { account: y1, amount: 6n },
        { account: y2, amount: 4n },
      ],
      [{ account: n1, amount: 2n }],
    );
    expect(slices.map((s) => [s.yesQty, s.noQty, s.yes?.toBase58(), s.no?.toBase58()])).toEqual([
      [6n, 2n, y1, n1],
      [4n, 0n, y2, n1], // the NO side is padded with quantity 0 on its first account
    ]);
  });

  it("a side with no account yields null (the ATA is created) and nothing held yields no slice", () => {
    const y = acct();
    expect(redeemSlices([{ account: y, amount: 3n }], [])[0]).toMatchObject({
      noQty: 0n,
      no: null,
    });
    expect(redeemSlices([], [])).toEqual([]);
  });
});
