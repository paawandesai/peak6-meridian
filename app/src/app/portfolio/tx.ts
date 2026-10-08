/**
 * Portfolio transactions (M2-07): `redeem` for a settled market and `settle_funds` (Withdraw) for
 * the wallet's OpenOrders balances. Each builder returns the instructions of ONE transaction, so
 * a button is one signature. Missing token accounts are created idempotently in the same
 * transaction, so a first redeem of a side the wallet never held still works.
 */
import { type Program } from "@coral-xyz/anchor";
import {
  BN,
  findOpenOrdersPda,
  type MarketAddresses,
  marketAddresses,
  type Meridian,
} from "@meridian/client";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";

import type { MarketRow } from "../../lib/markets";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export function addressesOf(market: MarketRow, programId: PublicKey): MarketAddresses {
  return marketAddresses(
    { symbol: market.ticker, tradingDate: market.tradingDate, strikeCents: market.strikeCents },
    programId,
  );
}

const ata = (mint: PublicKey, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner);

const createAta = (payer: PublicKey, mint: PublicKey, owner: PublicKey): TransactionInstruction =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, owner), owner, mint);

/** Token accounts to use instead of the associated ones (the wallet's existing accounts). */
export type TokenAccountOverrides = {
  readonly usdc?: PublicKey | null;
  readonly yes?: PublicKey | null;
  readonly no?: PublicKey | null;
};

export type RedeemParams = {
  readonly program: Program<Meridian>;
  readonly user: PublicKey;
  readonly usdcMint: PublicKey;
  readonly market: MarketRow;
  readonly yesQty: bigint;
  readonly noQty: bigint;
  /** Existing YES and NO token accounts of the wallet; an absent one falls back to the ATA. */
  readonly accounts?: TokenAccountOverrides;
};

/** Winner-mode redeem of the wallet's YES and NO in one settled market. */
export async function buildRedeem(params: RedeemParams): Promise<TransactionInstruction[]> {
  const { program, user, usdcMint, market } = params;
  if (!market.settled) throw new Error("only a settled market can be redeemed from the Portfolio");
  if (params.yesQty <= 0n && params.noQty <= 0n) throw new Error("nothing to redeem");
  const a = addressesOf(market, program.programId);
  const userYes = params.accounts?.yes ?? ata(a.yesMint, user);
  const userNo = params.accounts?.no ?? ata(a.noMint, user);
  const instruction = await program.methods
    .redeem(new BN(params.yesQty.toString()), new BN(params.noQty.toString()))
    .accountsStrict({
      market: a.market,
      user,
      userUsdc: params.accounts?.usdc ?? ata(usdcMint, user),
      userYes,
      userNo,
      yesMint: a.yesMint,
      noMint: a.noMint,
      vault: a.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return [
    ...(params.accounts?.usdc ? [] : [createAta(user, usdcMint, user)]),
    ...(params.accounts?.yes ? [] : [createAta(user, a.yesMint, user)]),
    ...(params.accounts?.no ? [] : [createAta(user, a.noMint, user)]),
    instruction,
  ];
}

export type WithdrawParams = {
  readonly program: Program<Meridian>;
  readonly owner: PublicKey;
  readonly usdcMint: PublicKey;
  readonly market: MarketRow;
};

/** `settle_funds`: moves the market's free USDC and YES from the OpenOrders account to the wallet. */
export async function buildWithdraw(params: WithdrawParams): Promise<TransactionInstruction[]> {
  const { program, owner, usdcMint, market } = params;
  const a = addressesOf(market, program.programId);
  const instruction = await program.methods
    .settleFunds()
    .accountsStrict({
      market: a.market,
      owner,
      openOrders: findOpenOrdersPda(a.market, owner, program.programId).address,
      escrowUsdc: a.escrowUsdc,
      escrowYes: a.escrowYes,
      userUsdc: ata(usdcMint, owner),
      userYes: ata(a.yesMint, owner),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return [createAta(owner, usdcMint, owner), createAta(owner, a.yesMint, owner), instruction];
}

/** A token account and what it holds (structurally `TokenSlice` from `data.ts`). */
export type HeldAccount = { readonly account: string; readonly amount: bigint };

export type RedeemSlice = {
  readonly yesQty: bigint;
  readonly noQty: bigint;
  readonly yes: PublicKey | null;
  readonly no: PublicKey | null;
};

/**
 * One redeem per account pair, so each instruction burns exactly what the accounts it names
 * hold (the program takes one YES and one NO account per call). A side with fewer accounts is
 * padded with quantity 0 against its first account (the program still needs a valid account;
 * a zero quantity burns nothing); a side with no accounts yields `null` (the ATA is created).
 */
export function redeemSlices(
  yes: readonly HeldAccount[],
  no: readonly HeldAccount[],
): RedeemSlice[] {
  const count = Math.max(yes.length, no.length, 1);
  const slices: RedeemSlice[] = [];
  for (let index = 0; index < count; index += 1) {
    const y = yes[index];
    const n = no[index];
    const yesAccount = y?.account ?? yes[0]?.account;
    const noAccount = n?.account ?? no[0]?.account;
    slices.push({
      yesQty: y?.amount ?? 0n,
      noQty: n?.amount ?? 0n,
      yes: yesAccount === undefined ? null : new PublicKey(yesAccount),
      no: noAccount === undefined ? null : new PublicKey(noAccount),
    });
  }
  return slices.filter((slice) => slice.yesQty > 0n || slice.noQty > 0n);
}

/** Transactions stay under the 1232-byte limit with at most this many markets in each. */
export const MARKETS_PER_TRANSACTION = 3;

export function chunk<T>(items: readonly T[], size: number = MARKETS_PER_TRANSACTION): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    out.push(items.slice(start, start + size));
  return out;
}
