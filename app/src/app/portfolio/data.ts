/**
 * Chain reads for the Portfolio (M2-07): the wallet's token balances, its OpenOrders accounts,
 * its resting orders and its program events. Read-only; transactions are built in `tx.ts`.
 * Events come through the shared decoder (`@/lib/events`), never a second one.
 */
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  createMeridianProgram,
  findOpenOrdersPda,
  marketAddresses,
  type Meridian,
} from "@meridian/client";
import { type Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";

import type { PublicConfig } from "@/lib/config";
import { decodeEvents, type MeridianEvent } from "@/lib/events";
import type { MarketRow } from "@/lib/markets";

/** SPL Token program. */
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Signatures read per address; hitting it marks the history as partial. */
export const SIGNATURE_LIMIT = 200;
const TX_BATCH = 25;

/** One of the wallet's token accounts for a mint and the amount it holds. */
export type TokenSlice = { readonly account: string; readonly amount: bigint };

/**
 * Wallet token balances of one market: the totals and the accounts they are spread over, so a
 * redeem burns from each account exactly what that account holds.
 */
export type Holdings = {
  readonly yes: bigint;
  readonly no: bigint;
  readonly yesAccounts: readonly TokenSlice[];
  readonly noAccounts: readonly TokenSlice[];
};

export type OpenOrdersRow = {
  readonly market: string;
  readonly freeUsdc: bigint;
  readonly freeYes: bigint;
  readonly restingCount: number;
};

export type RestingOrder = {
  readonly market: string;
  readonly orderId: bigint;
  readonly side: "Bid" | "Ask";
  readonly price: number;
  readonly qty: bigint;
};

export type PortfolioSnapshot = {
  /** Keyed by market address; a market with no balance is absent. */
  readonly holdings: Readonly<Record<string, Holdings>>;
  readonly openOrders: readonly OpenOrdersRow[];
  readonly resting: readonly RestingOrder[];
  /** Oldest first. */
  readonly events: readonly MeridianEvent[];
  /** True when any address returned a full page of signatures (older history is not read). */
  readonly eventsPartial: boolean;
  /** The wallet's fullest test-USDC account (redeemed USDC is paid into it); `null` if none. */
  readonly usdcAccount: string | null;
};

export type PortfolioSource = {
  load(wallet: PublicKey, markets: readonly MarketRow[]): Promise<PortfolioSnapshot>;
};

const tokenAccounts = z.object({
  value: z.array(
    z.object({
      account: z.object({
        data: z.object({
          parsed: z.object({
            info: z.object({ mint: z.string(), tokenAmount: z.object({ amount: z.string() }) }),
          }),
        }),
      }),
      pubkey: z.union([z.string(), z.instanceof(PublicKey)]),
    }),
  ),
});

/** The owner's total for one mint and the accounts holding it, fullest first (base58). */
export type MintBalance = { readonly amount: bigint; readonly accounts: readonly TokenSlice[] };

/** The owner's token balances by mint (base58). */
export async function fetchBalancesByMint(
  connection: Pick<Connection, "getParsedTokenAccountsByOwner">,
  owner: PublicKey,
): Promise<Map<string, MintBalance>> {
  const response = tokenAccounts.parse(
    await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
  );
  const slices = new Map<string, TokenSlice[]>();
  for (const { account, pubkey } of response.value) {
    const { mint, tokenAmount } = account.data.parsed.info;
    const list = slices.get(mint) ?? [];
    list.push({ account: String(pubkey), amount: BigInt(tokenAmount.amount) });
    slices.set(mint, list);
  }
  const balances = new Map<string, MintBalance>();
  for (const [mint, list] of slices) {
    const accounts = [...list].sort((x, y) =>
      x.amount > y.amount ? -1 : x.amount < y.amount ? 1 : 0,
    );
    balances.set(mint, { amount: accounts.reduce((sum, item) => sum + item.amount, 0n), accounts });
  }
  return balances;
}

/** Wallet YES and NO balances for each market (markets with neither are left out). */
export function holdingsFor(
  balances: ReadonlyMap<string, MintBalance>,
  markets: readonly MarketRow[],
  programId: PublicKey,
): Record<string, Holdings> {
  const out: Record<string, Holdings> = {};
  for (const market of markets) {
    const addresses = marketAddresses(
      { symbol: market.ticker, tradingDate: market.tradingDate, strikeCents: market.strikeCents },
      programId,
    );
    const yes = balances.get(addresses.yesMint.toBase58());
    const no = balances.get(addresses.noMint.toBase58());
    if ((yes?.amount ?? 0n) > 0n || (no?.amount ?? 0n) > 0n) {
      out[market.address] = {
        yes: yes?.amount ?? 0n,
        no: no?.amount ?? 0n,
        yesAccounts: (yes?.accounts ?? []).filter((item) => item.amount > 0n),
        noAccounts: (no?.accounts ?? []).filter((item) => item.amount > 0n),
      };
    }
  }
  return out;
}

export type SignatureEntry = { readonly signature: string; readonly slot: number };

/**
 * One oldest-first list from several `getSignaturesForAddress` pages. Each page is newest-first,
 * and within a slot that order is the only record of which transaction came first, so every page
 * is reversed before merging. Across slots the slot decides; inside a slot the pages' relative
 * orders are merged (a signature waits until nothing older than it, in any page, is left).
 */
export function orderSignatures(pages: readonly (readonly SignatureEntry[])[]): string[] {
  const slotOf = new Map<string, number>();
  const oldestFirst = pages.map((page) => [...page].reverse());
  for (const page of oldestFirst) for (const entry of page) slotOf.set(entry.signature, entry.slot);
  const slots = [...new Set(slotOf.values())].sort((a, b) => a - b);
  const out: string[] = [];
  for (const slot of slots) {
    const queues = oldestFirst
      .map((page) => page.filter((entry) => entry.slot === slot).map((entry) => entry.signature))
      .filter((queue) => queue.length > 0);
    const done = new Set<string>();
    while (queues.some((queue) => queue.some((signature) => !done.has(signature)))) {
      const heads = queues
        .map((queue) => queue.find((signature) => !done.has(signature)))
        .filter((signature): signature is string => signature !== undefined);
      // A head is safe when it is not waiting behind another signature in any other queue.
      const next =
        heads.find((head) =>
          queues.every((queue) => {
            const at = queue.indexOf(head);
            return at <= 0 || queue.slice(0, at).every((earlier) => done.has(earlier));
          }),
        ) ?? heads[0];
      if (next === undefined) break;
      done.add(next);
      out.push(next);
    }
  }
  return out;
}

/** The slice of `Connection` that `fetchWalletEvents` uses. */
export type EventConnection = Pick<Connection, "getSignaturesForAddress" | "getTransactions">;

/**
 * Events of the transactions that touch any of `addresses` (the wallet and its OpenOrders PDAs:
 * a maker's fills happen in the taker's transaction, which names the maker's OpenOrders, not the
 * maker's wallet). Failed transactions are skipped. Oldest first.
 */
export async function fetchWalletEvents(
  connection: EventConnection,
  addresses: readonly PublicKey[],
  programId: PublicKey,
): Promise<{ events: MeridianEvent[]; partial: boolean }> {
  let partial = false;
  const pages: SignatureEntry[][] = [];
  for (const address of addresses) {
    const signatures = await connection.getSignaturesForAddress(
      address,
      { limit: SIGNATURE_LIMIT },
      "confirmed",
    );
    if (signatures.length >= SIGNATURE_LIMIT) partial = true;
    pages.push(signatures.filter((entry) => entry.err === null));
  }
  const ordered = orderSignatures(pages);
  const events: MeridianEvent[] = [];
  for (let start = 0; start < ordered.length; start += TX_BATCH) {
    const batch = ordered.slice(start, start + TX_BATCH);
    const transactions = await connection.getTransactions(batch, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    transactions.forEach((transaction, offset) => {
      const signature = batch[offset];
      const logs = transaction?.meta?.logMessages;
      if (signature === undefined || transaction === null || !logs) return;
      events.push(
        ...decodeEvents(logs, { signature, blockTime: transaction.blockTime ?? null }, programId),
      );
    });
  }
  return { events, partial };
}

/** Anchor's decoded order and book shapes for the fields the Portfolio reads. */
type RawOrder = {
  orderId: { toString(): string };
  owner: PublicKey;
  price: number;
  qty: { toString(): string };
};
type RawBook = { bids: RawOrder[]; asks: RawOrder[] };

/** The wallet's resting orders in `book`, empty slots (`qty == 0`) skipped. */
export function restingOrders(market: string, book: RawBook, owner: PublicKey): RestingOrder[] {
  const own = (side: "Bid" | "Ask", orders: RawOrder[]): RestingOrder[] =>
    orders
      .filter((order) => order.owner.equals(owner) && BigInt(order.qty.toString()) > 0n)
      .map((order) => ({
        market,
        orderId: BigInt(order.orderId.toString()),
        side,
        price: order.price,
        qty: BigInt(order.qty.toString()),
      }));
  return [...own("Bid", book.bids), ...own("Ask", book.asks)];
}

const readOnlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("read-only client cannot sign")),
  signAllTransactions: () => Promise.reject(new Error("read-only client cannot sign")),
};

export function createPortfolioSource(config: PublicConfig): PortfolioSource {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" });
  const program: Program<Meridian> = createMeridianProgram(provider, config.programId);
  return {
    async load(wallet, markets) {
      const addressOf = new Map(markets.map((market) => [market.address, market]));
      const [balances, accounts] = await Promise.all([
        fetchBalancesByMint(connection, wallet),
        program.account.openOrders.all([{ memcmp: { offset: 8, bytes: wallet.toBase58() } }]),
      ]);
      const openOrders: OpenOrdersRow[] = accounts
        .filter((entry) => addressOf.has(entry.account.market.toBase58()))
        .map((entry) => ({
          market: entry.account.market.toBase58(),
          freeUsdc: BigInt(entry.account.freeUsdc.toString()),
          freeYes: BigInt(entry.account.freeYes.toString()),
          restingCount: entry.account.restingCount,
        }));

      const withOrders = openOrders.filter((row) => row.restingCount > 0);
      const books = await program.account.book.fetchMultiple(
        withOrders.map(
          (row) => marketAddresses(marketKeyOf(addressOf.get(row.market)), config.programId).book,
        ),
      );
      const resting = withOrders.flatMap((row, index) => {
        const book = books[index];
        return book === null || book === undefined
          ? []
          : restingOrders(row.market, book as unknown as RawBook, wallet);
      });

      const pdas = openOrders.map(
        (row) => findOpenOrdersPda(new PublicKey(row.market), wallet, config.programId).address,
      );
      const { events, partial } = await fetchWalletEvents(
        connection,
        [wallet, ...pdas],
        config.programId,
      );
      return {
        holdings: holdingsFor(balances, markets, config.programId),
        openOrders,
        resting,
        events,
        eventsPartial: partial,
        usdcAccount:
          config.usdcMint === undefined
            ? null
            : (balances.get(config.usdcMint.toBase58())?.accounts[0]?.account ?? null),
      };
    },
  };
}

function marketKeyOf(market: MarketRow | undefined) {
  if (market === undefined) throw new Error("open orders for an unknown market");
  return {
    symbol: market.ticker,
    tradingDate: market.tradingDate,
    strikeCents: market.strikeCents,
  };
}
