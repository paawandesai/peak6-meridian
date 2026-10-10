/** Node-side chain reads and setup the specs share. Setup transactions are signed here, never in the page. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AnchorProvider, type Program, Wallet } from "@coral-xyz/anchor";
import {
  BN,
  buildTrade,
  closeTimeET,
  createMeridianProgram,
  findConfigPda,
  type Intent,
  isTradingDay,
  marketAddresses,
  type MarketAddresses,
  type Meridian,
  nextTradingDay,
  type OrderKindName,
  symbolBytes,
  tradingDateET,
} from "@meridian/client";
import {
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { type Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import { loadKeypairFile, programIdOf, type StackState } from "./state";

/** Test-USDC balance (base units) of `owner`, 0 when it has no token account yet. */
export async function usdcBalance(
  connection: Connection,
  state: StackState,
  owner: PublicKey,
): Promise<bigint> {
  return tokenBalance(
    connection,
    getAssociatedTokenAddressSync(new PublicKey(state.usdcMint), owner),
  );
}

export async function tokenBalance(connection: Connection, account: PublicKey): Promise<bigint> {
  const balance = await connection.getTokenAccountBalance(account, "confirmed").catch(() => null);
  return balance === null ? 0n : BigInt(balance.value.amount);
}

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const CREATE_MARKETS_CLI = resolve(ROOT, "services/automation/src/cli/create-markets.ts");
const STRIKE_CENTS_TO_SCALED = 10n ** 16n;
const UNITS_PER_USDC = 1_000_000n;

export type Chain = {
  readonly connection: Connection;
  readonly admin: Keypair;
  readonly provider: AnchorProvider;
  readonly program: Program<Meridian>;
  readonly programId: PublicKey;
};

export function openChain(state: StackState, connection: Connection): Chain {
  const admin = loadKeypairFile(state.adminKeypairPath);
  const provider = new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" });
  const programId = programIdOf(state);
  return {
    connection,
    admin,
    provider,
    program: createMeridianProgram(provider, programId),
    programId,
  };
}

/** Addresses of a seeded market, e.g. META at $680 (the lifecycle seed's traded strike). */
export function seededMarket(
  chain: Chain,
  state: StackState,
  symbol: string,
  strikeCents: bigint,
): MarketAddresses {
  return marketAddresses({ symbol, tradingDate: state.tradingDate, strikeCents }, chain.programId);
}

type Accounts = { usdc: PublicKey; yes: PublicKey; no: PublicKey };

/** Idempotent associated token accounts of `owner` for test-USDC and the market's YES/NO. */
export async function tokenAccounts(
  chain: Chain,
  state: StackState,
  owner: PublicKey,
  market: MarketAddresses,
): Promise<Accounts> {
  const make = (mint: PublicKey) =>
    createAssociatedTokenAccountIdempotent(chain.connection, chain.admin, mint, owner);
  return {
    usdc: await make(new PublicKey(state.usdcMint)),
    yes: await make(market.yesMint),
    no: await make(market.noMint),
  };
}

/** A funded counterparty with `pairs` minted pairs, to rest orders the test wallet trades against. */
export async function fundMaker(
  chain: Chain,
  state: StackState,
  market: MarketAddresses,
  pairs: bigint,
): Promise<{ keypair: Keypair; accounts: Accounts }> {
  const keypair = Keypair.generate();
  const fund = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: chain.admin.publicKey,
      toPubkey: keypair.publicKey,
      lamports: 2_000_000_000,
    }),
  );
  await chain.provider.sendAndConfirm(fund, [chain.admin], { commitment: "confirmed" });
  const accounts = await tokenAccounts(chain, state, keypair.publicKey, market);
  await mintTo(
    chain.connection,
    chain.admin,
    new PublicKey(state.usdcMint),
    accounts.usdc,
    chain.admin,
    1_000n * UNITS_PER_USDC,
  );
  await mintPairs(chain, market, keypair, accounts, pairs);
  return { keypair, accounts };
}

/** Mints `usdc` whole test-USDC to `account` (the admin is the throwaway seed's mint authority). */
export async function fundUsdc(
  chain: Chain,
  state: StackState,
  account: PublicKey,
  usdc: bigint,
): Promise<void> {
  await mintTo(
    chain.connection,
    chain.admin,
    new PublicKey(state.usdcMint),
    account,
    chain.admin,
    usdc * UNITS_PER_USDC,
  );
}

export async function mintPairs(
  chain: Chain,
  market: MarketAddresses,
  owner: Keypair,
  accounts: Accounts,
  pairs: bigint,
): Promise<void> {
  await chain.program.methods
    .mintPair(new BN(pairs.toString()))
    .accountsStrict({
      config: findConfigPda(chain.programId).address,
      market: market.market,
      user: owner.publicKey,
      userUsdc: accounts.usdc,
      userYes: accounts.yes,
      userNo: accounts.no,
      yesMint: market.yesMint,
      noMint: market.noMint,
      vault: market.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([owner])
    .rpc({ commitment: "confirmed" });
}

/** The maker rests (or fills) an order through the same client builder the app uses. */
export async function makerOrder(
  chain: Chain,
  market: MarketAddresses,
  maker: { keypair: Keypair; accounts: Accounts },
  order: { intent: Intent; kind: OrderKindName; priceCents: number; qty: bigint },
): Promise<void> {
  const ix = await buildTrade({
    program: chain.program,
    ...order,
    accounts: {
      user: maker.keypair.publicKey,
      userUsdc: maker.accounts.usdc,
      userYes: maker.accounts.yes,
      userNo: maker.accounts.no,
      market,
    },
    makers: [],
  });
  const tx = new Transaction().add(ix);
  await chain.provider.sendAndConfirm(tx, [maker.keypair], { commitment: "confirmed" });
}

async function chainTime(connection: Connection): Promise<number> {
  const time = await connection.getBlockTime(await connection.getSlot("confirmed"));
  if (time === null) throw new Error("cluster returned no block time");
  return time;
}

/** Where the create-markets CLI runs: the stack's RPC, its throwaway admin key and the program. */
export type CreateMarketsTarget = Pick<StackState, "rpcUrl" | "adminKeypairPath" | "programId">;

/**
 * Runs the create-markets CLI (the real morning job) against the local validator with a
 * throwaway previous-closes file; returns its stdout ("created <SYMBOL> <strike> <sig>" lines).
 */
function runCreateMarkets(
  target: CreateMarketsTarget,
  prevCloses: { readonly tradingDate: string; readonly closes: Record<string, number> },
  args: readonly string[],
): string {
  const dir = mkdtempSync(join(tmpdir(), "meridian-pw-markets-"));
  const file = join(dir, "prev_closes.json");
  writeFileSync(file, JSON.stringify(prevCloses));
  return execFileSync(
    "pnpm",
    [
      "--filter",
      "automation",
      "exec",
      "tsx",
      CREATE_MARKETS_CLI,
      "--prev-closes",
      file,
      ...args,
      "--program-id",
      target.programId,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ANCHOR_PROVIDER_URL: target.rpcUrl,
        ANCHOR_WALLET: target.adminKeypairPath,
        SOLANA_CLUSTER: "localnet",
      },
    },
  );
}

/**
 * Trading date of the lifecycle seed's `--close-in-secs` markets (tests/fixtures/prev_closes.json).
 * They close at "now + N", not at the session close, so every page files them as test markets
 * (P0-1); the specs only use this date for the short redeem market below.
 */
export const TEST_MARKET_DATE = "2026-10-06";

/**
 * A strike that closes `closeInSecs` after this call, so the redeem step can settle it locally
 * without waiting for a session close: the create-markets CLI with a previous close of $1,360.00
 * for META (the seed uses $680.00), whose strikes do not overlap the seed's. It is a test market
 * (its close is not the session close), so the UI lists it only behind "Show test markets".
 */
export async function createShortMarket(
  chain: Chain,
  state: StackState,
  closeInSecs: number,
): Promise<{ market: MarketAddresses; strikeCents: bigint; closeTs: number }> {
  const out = runCreateMarkets(
    state,
    { tradingDate: TEST_MARKET_DATE, closes: { META: 136_000 } },
    ["--close-in-secs", String(closeInSecs)],
  );
  const created = [...out.matchAll(/^created META (\d+) \S+$/gm)];
  const strike = created[0]?.[1];
  if (strike === undefined) throw new Error(`create-markets created no META market:\n${out}`);
  const strikeCents = BigInt(strike);
  const tradingDate = Number(TEST_MARKET_DATE.replaceAll("-", ""));
  const market = marketAddresses({ symbol: "META", tradingDate, strikeCents }, chain.programId);
  const account = await chain.program.account.market.fetch(market.market);
  return { market, strikeCents, closeTs: Number(account.closeTs.toString()) };
}

/**
 * The next session whose 16:00 ET (or early) close is at least `marginSecs` away, as an ISO date,
 * from the shared NYSE calendar (America/New_York, never a hardcoded offset).
 */
export function nextOpenSession(nowMs: number, marginSecs: number): string {
  let date = tradingDateET(new Date(nowMs));
  for (let i = 0; i < 14; i += 1) {
    if (isTradingDay(date) && closeTimeET(date).closeTs > Math.floor(nowMs / 1000) + marginSecs) {
      return date;
    }
    date = nextTradingDay(date);
  }
  throw new Error(`no open session within two weeks of ${new Date(nowMs).toISOString()}`);
}

/**
 * Real session ladders (close_ts = the session's ET close, so Markets, Trade and Portfolio list
 * them by default; P0-1) for every symbol in `closes`, on the next session whose close is at least
 * `marginSecs` away: the create-markets CLI without `--close-in-secs`. Idempotent. Returns the
 * session's trading date as `YYYYMMDD`.
 */
export function createSessionLadders(
  target: CreateMarketsTarget,
  closes: Record<string, number>,
  marginSecs: number,
): number {
  const isoDate = nextOpenSession(Date.now(), marginSecs);
  runCreateMarkets(target, { tradingDate: isoDate, closes }, ["--date", isoDate]);
  return Number(isoDate.replaceAll("-", ""));
}

/**
 * One real session market for `symbol` at `prevCloseCents` on the next open session (see
 * `createSessionLadders`). Idempotent; returns the strike that equals the previous close (the
 * ladder always contains it).
 */
export function createSessionMarket(
  chain: Chain,
  state: StackState,
  symbol: string,
  prevCloseCents: number,
): { market: MarketAddresses; tradingDate: number; strikeCents: bigint } {
  const tradingDate = createSessionLadders(state, { [symbol]: prevCloseCents }, 1_800);
  const strikeCents = BigInt(prevCloseCents);
  return {
    market: marketAddresses({ symbol, tradingDate, strikeCents }, chain.programId),
    tradingDate,
    strikeCents,
  };
}

/** Waits for the cluster clock to pass `closeTs`; fails only if it stalls for a minute. */
export async function waitForClose(connection: Connection, closeTs: number): Promise<void> {
  let last = 0;
  let lastAdvance = Date.now();
  for (;;) {
    const now = await chainTime(connection);
    if (now >= closeTs) return;
    if (now > last) {
      last = now;
      lastAdvance = Date.now();
    } else if (Date.now() - lastAdvance > 60_000) {
      throw new Error(`cluster clock stalled at ${now}, ${closeTs - now}s before close_ts`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** Local oracle: both sources report `priceCents`, then `settle_market` (permissionless). */
export async function settleLocally(
  chain: Chain,
  market: MarketAddresses,
  symbol: string,
  priceCents: bigint,
): Promise<void> {
  const feed = (slot: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("local_feed"), symbolBytes(symbol), Buffer.from([slot])],
      chain.programId,
    )[0];
  const value = new BN((priceCents * STRIKE_CENTS_TO_SCALED).toString());
  for (const slot of [0, 1]) {
    await chain.program.methods
      .localOracleSet(
        Array.from(symbolBytes(symbol)),
        slot,
        value,
        new BN(await chain.connection.getSlot("confirmed")),
      )
      .accountsStrict({
        config: findConfigPda(chain.programId).address,
        localFeed: feed(slot),
        admin: chain.admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });
  }
  await chain.program.methods
    .settleMarket(null)
    .accountsStrict({
      config: findConfigPda(chain.programId).address,
      market: market.market,
      feedTiingo: feed(0),
      feedTwelveData: feed(1),
      redstonePrice: null,
      oracleConfig: null,
      instructionsSysvar: null,
      payer: chain.admin.publicKey,
    })
    .rpc({ commitment: "confirmed" });
}
