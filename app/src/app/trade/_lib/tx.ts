/**
 * Trade transactions (M2-06). Every action is ONE transaction and ONE wallet signature: the
 * trade instruction, preceded by idempotent token-account creation and followed by
 * `settle_funds` so fills reach the wallet without a second prompt (domain.md § Order book
 * rules). Nothing is signed server-side and no key is read here. `TradeActions` is the seam the
 * page and its tests use.
 */
import { AnchorProvider, BN, type Program, type Wallet } from "@coral-xyz/anchor";
import {
  buildTrade,
  createMeridianProgram,
  findConfigPda,
  findOpenOrdersPda,
  type Intent,
  type Meridian,
  marketAddresses,
  type MarketAddresses,
  type OrderKindName,
  yesPriceFor,
} from "@meridian/client";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  type Connection,
  PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { type FullBook, makersFor } from "./book-view";
import { txErrorText } from "./errors";
import type { PublicConfig } from "@/lib/config";
import { decodeEvents, type MeridianEvent } from "@/lib/events";
import type { MarketRow } from "@/lib/markets";

export type TradeRequest = {
  readonly intent: Intent;
  readonly kind: OrderKindName;
  /** Limit or worst price in cents, in the intent's own terms. */
  readonly priceCents: number;
  readonly qty: bigint;
  /** The book the order was priced against; used to name the makers it may fill. */
  readonly book: FullBook;
};

export type SimulationOutcome =
  | { readonly ok: true; readonly events: readonly MeridianEvent[] }
  | { readonly ok: false; readonly reason: string };

export type SubmitResult = { readonly signature: string; readonly slot: number };

/** Where a submit is: waiting for the wallet's signature, or sent and waiting for confirmation. */
export type Phase = "awaiting-signature" | "confirming";
export type OnPhase = (phase: Phase) => void;

export type TradeActions = {
  /** Builds the transaction and simulates it (no signature). */
  simulate(request: TradeRequest): Promise<SimulationOutcome>;
  /** Builds, asks the wallet to sign once, sends and confirms. */
  trade(request: TradeRequest, onPhase?: OnPhase): Promise<SubmitResult>;
  /** Cancels one resting order and withdraws what it returns. */
  cancel(orderId: bigint, onPhase?: OnPhase): Promise<SubmitResult>;
  /** `settle_funds`: withdraws the free balance. */
  withdraw(onPhase?: OnPhase): Promise<SubmitResult>;
  /** Burns `qty` YES and `qty` NO for `qty` USDC (before settlement). */
  redeemPair(qty: bigint, onPhase?: OnPhase): Promise<SubmitResult>;
  /** After settlement: burns the whole YES and NO balances (winners pay $1.00, losers $0.00). */
  redeemWinner(yesQty: bigint, noQty: bigint, onPhase?: OnPhase): Promise<SubmitResult>;
};

/** The slice of the wallet adapter the trade transactions need. */
export type SigningWallet = {
  readonly publicKey: PublicKey;
  signTransaction<T extends VersionedTransaction>(tx: T): Promise<T>;
};

/** The slice of `Connection` the trade transactions use (a fake in tests). */
export type TradeConnection = Pick<
  Connection,
  | "getLatestBlockhash"
  | "simulateTransaction"
  | "sendRawTransaction"
  | "confirmTransaction"
  | "getSignatureStatuses"
>;

export type TradeTarget = {
  readonly program: Program<Meridian>;
  readonly user: PublicKey;
  readonly usdcMint: PublicKey;
  readonly addresses: MarketAddresses;
};

/** Resolves the market's PDAs and checks they match the address the page was opened with. */
export function targetFor(
  row: MarketRow,
  program: Program<Meridian>,
  user: PublicKey,
  usdcMint: PublicKey,
): TradeTarget {
  const addresses = marketAddresses(
    { symbol: row.ticker, tradingDate: row.tradingDate, strikeCents: row.strikeCents },
    program.programId,
  );
  if (addresses.market.toBase58() !== row.address) {
    throw new Error("market address does not match its ticker, date and strike");
  }
  return { program, user, usdcMint, addresses };
}

function ataFor(target: TradeTarget): { usdc: PublicKey; yes: PublicKey; no: PublicKey } {
  return {
    usdc: getAssociatedTokenAddressSync(target.usdcMint, target.user),
    yes: getAssociatedTokenAddressSync(target.addresses.yesMint, target.user),
    no: getAssociatedTokenAddressSync(target.addresses.noMint, target.user),
  };
}

/** Creates the wallet's token accounts when they are missing (a no-op when they exist). */
export function ensureAccounts(target: TradeTarget, withNo: boolean): TransactionInstruction[] {
  const atas = ataFor(target);
  const make = (ata: PublicKey, mint: PublicKey) =>
    createAssociatedTokenAccountIdempotentInstruction(target.user, ata, target.user, mint);
  return [
    make(atas.usdc, target.usdcMint),
    make(atas.yes, target.addresses.yesMint),
    ...(withNo ? [make(atas.no, target.addresses.noMint)] : []),
  ];
}

/** `settle_funds` for the wallet on this market. */
export async function settleFundsInstruction(target: TradeTarget): Promise<TransactionInstruction> {
  const atas = ataFor(target);
  return target.program.methods
    .settleFunds()
    .accountsStrict({
      market: target.addresses.market,
      owner: target.user,
      openOrders: findOpenOrdersPda(target.addresses.market, target.user, target.program.programId)
        .address,
      escrowUsdc: target.addresses.escrowUsdc,
      escrowYes: target.addresses.escrowYes,
      userUsdc: atas.usdc,
      userYes: atas.yes,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** All instructions of one trade: account setup, the trade, then the automatic `settle_funds`. */
export async function tradeInstructions(
  target: TradeTarget,
  request: TradeRequest,
): Promise<TransactionInstruction[]> {
  const atas = ataFor(target);
  const yesPrice = yesPriceFor(request.intent, request.priceCents);
  const trade = await buildTrade({
    program: target.program,
    intent: request.intent,
    kind: request.kind,
    priceCents: request.priceCents,
    qty: request.qty,
    accounts: {
      user: target.user,
      userUsdc: atas.usdc,
      userYes: atas.yes,
      userNo: atas.no,
      market: target.addresses,
    },
    makers: makersFor(request.intent, yesPrice, request.book, target.user.toBase58()).map(
      (owner) => new PublicKey(owner),
    ),
  });
  const noIntent = request.intent === "BUY_NO" || request.intent === "SELL_NO";
  return [...ensureAccounts(target, noIntent), trade, await settleFundsInstruction(target)];
}

async function cancelInstructions(
  target: TradeTarget,
  orderId: bigint,
): Promise<TransactionInstruction[]> {
  const cancel = await target.program.methods
    .cancelOrder(new BN(orderId.toString()))
    .accountsStrict({
      market: target.addresses.market,
      book: target.addresses.book,
      owner: target.user,
      openOrders: findOpenOrdersPda(target.addresses.market, target.user, target.program.programId)
        .address,
    })
    .instruction();
  return [...ensureAccounts(target, false), cancel, await settleFundsInstruction(target)];
}

async function redeemInstructions(
  target: TradeTarget,
  yesQty: bigint,
  noQty: bigint,
): Promise<TransactionInstruction[]> {
  const atas = ataFor(target);
  const redeem = await target.program.methods
    .redeem(new BN(yesQty.toString()), new BN(noQty.toString()))
    .accountsStrict({
      market: target.addresses.market,
      user: target.user,
      userUsdc: atas.usdc,
      userYes: atas.yes,
      userNo: atas.no,
      yesMint: target.addresses.yesMint,
      noMint: target.addresses.noMint,
      vault: target.addresses.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return [...ensureAccounts(target, true), redeem];
}

export function createTradeActions(
  connection: TradeConnection,
  wallet: SigningWallet,
  config: PublicConfig,
  row: MarketRow,
  usdcMintOverride?: PublicKey,
): TradeActions {
  // Only used to encode instructions; reads never go through this read-only-wallet provider.
  const provider = new AnchorProvider(connection as Connection, wallet as unknown as Wallet, {
    commitment: "confirmed",
  });
  const program = createMeridianProgram(provider, config.programId);
  let targetPromise: Promise<TradeTarget> | undefined;
  const target = (): Promise<TradeTarget> => {
    targetPromise ??= (async () => {
      const usdcMint =
        usdcMintOverride ??
        config.usdcMint ??
        (await program.account.config.fetch(findConfigPda(config.programId).address)).usdcMint;
      return targetFor(row, program, wallet.publicKey, usdcMint);
    })();
    return targetPromise;
  };

  async function compile(
    instructions: readonly TransactionInstruction[],
  ): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [...instructions],
    }).compileToV0Message();
    return { tx: new VersionedTransaction(message), blockhash, lastValidBlockHeight };
  }

  /** Exactly one `signTransaction` call, then send and confirm. */
  async function signAndSend(
    instructions: readonly TransactionInstruction[],
    onPhase?: OnPhase,
  ): Promise<SubmitResult> {
    const { tx, blockhash, lastValidBlockHeight } = await compile(instructions);
    onPhase?.("awaiting-signature");
    const signed = await wallet.signTransaction(tx);
    onPhase?.("confirming");
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      preflightCommitment: "confirmed",
    });
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (confirmation.value.err !== null) throw new Error(txErrorText(confirmation.value.err));
    const { value } = await connection.getSignatureStatuses([signature]);
    return { signature, slot: value[0]?.slot ?? 0 };
  }

  return {
    async simulate(request) {
      const instructions = await tradeInstructions(await target(), request);
      const { tx } = await compile(instructions);
      const { value } = await connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      });
      if (value.err !== null) return { ok: false, reason: txErrorText(value.err, value.logs) };
      const events = decodeEvents(value.logs ?? [], { signature: "simulation" }, config.programId);
      return { ok: true, events };
    },
    async trade(request, onPhase) {
      return signAndSend(await tradeInstructions(await target(), request), onPhase);
    },
    async cancel(orderId, onPhase) {
      return signAndSend(await cancelInstructions(await target(), orderId), onPhase);
    },
    async withdraw(onPhase) {
      const t = await target();
      return signAndSend([...ensureAccounts(t, false), await settleFundsInstruction(t)], onPhase);
    },
    async redeemPair(qty, onPhase) {
      return signAndSend(await redeemInstructions(await target(), qty, qty), onPhase);
    },
    async redeemWinner(yesQty, noQty, onPhase) {
      return signAndSend(await redeemInstructions(await target(), yesQty, noQty), onPhase);
    },
  };
}
