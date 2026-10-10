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
  createMeridianProgram,
  findConfigPda,
  type Intent,
  marketAddresses,
  type MarketAddresses,
  type Meridian,
  type OrderKindName,
  symbolBytes,
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

/**
 * A strike that closes `closeInSecs` after this call, so the redeem step can settle it locally
 * without waiting for the 8 h seed markets: the create-markets CLI with a previous close of
 * $1,360.00 for META (the seed uses $680.00), whose strikes do not overlap the seed's.
 */
export async function createShortMarket(
  chain: Chain,
  state: StackState,
  closeInSecs: number,
): Promise<{ market: MarketAddresses; strikeCents: bigint; closeTs: number }> {
  const dir = mkdtempSync(join(tmpdir(), "meridian-pw-short-"));
  const file = join(dir, "prev_closes.json");
  writeFileSync(file, JSON.stringify({ tradingDate: "2026-10-06", closes: { META: 136_000 } }));
  const out = execFileSync(
    "pnpm",
    [
      "--filter",
      "automation",
      "exec",
      "tsx",
      CREATE_MARKETS_CLI,
      "--prev-closes",
      file,
      "--close-in-secs",
      String(closeInSecs),
      "--program-id",
      state.programId,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ANCHOR_PROVIDER_URL: state.rpcUrl,
        ANCHOR_WALLET: state.adminKeypairPath,
      },
    },
  );
  const created = [...out.matchAll(/^created META (\d+) \S+$/gm)];
  const strike = created[0]?.[1];
  if (strike === undefined) throw new Error(`create-markets created no META market:\n${out}`);
  const strikeCents = BigInt(strike);
  const market = seededMarket(chain, state, "META", strikeCents);
  const account = await chain.program.account.market.fetch(market.market);
  return { market, strikeCents, closeTs: Number(account.closeTs.toString()) };
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
    .settleMarket()
    .accountsStrict({
      config: findConfigPda(chain.programId).address,
      market: market.market,
      feedTiingo: feed(0),
      feedTwelveData: feed(1),
      redstonePrice: null,
      oracleConfig: null,
      payer: chain.admin.publicKey,
    })
    .rpc({ commitment: "confirmed" });
}
