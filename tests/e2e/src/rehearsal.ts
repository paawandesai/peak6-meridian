/**
 * The `--cluster devnet` path of `lifecycle.ts` (M2-12): the Thursday rehearsal against a deployed
 * program whose Config, markets and settlement are owned by M2-01..M2-04, not created here.
 *
 *   --phase markets   fallback market creation with the create-markets CLI (before 09:00 ET)
 *   --phase trade     fund trader-a/b, run the four intents on a real strike, save the state
 *   --phase redeem    after the 16:05 ET settlement: settle_funds, redeem, exact P&L check
 *
 * Environment: SOLANA_CLUSTER (`devnet`, or `localnet` with a loopback URL for rehearsing the
 * script itself), SOLANA_RPC_URL, ADMIN_KEYPAIR_PATH (payer and SOL funder); FAUCET_KEYPAIR (JSON
 * array) only with `--fund direct`; ANCHOR_WALLET (the automation authority's keypair file) only
 * with `--phase markets`; optional MERIDIAN_PROGRAM_ID. Nothing secret is printed, and RPC URLs
 * (which may carry an API key) are redacted from every error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AnchorProvider, type Program, Wallet } from "@coral-xyz/anchor";
import {
  assertCluster,
  BN,
  buildTrade,
  createMeridianProgram,
  findConfigPda,
  findOpenOrdersPda,
  type Intent,
  MERIDIAN_PROGRAM_ID,
  marketAddresses,
  type MarketAddresses,
  type Meridian,
  type OrderKindName,
  redactRpcUrl,
  symbolBytes,
  symbolFromBytes,
} from "@meridian/client";
import {
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { z } from "zod";

import { claimFromFaucet } from "./faucet-claim";
import { Ledger, UNITS_PER_CENT, UNITS_PER_USDC } from "./ledger";
import {
  assertFunded,
  explorerUrl,
  expectedCashChange,
  type MarketRow,
  parseRehearsalArgs,
  parseState,
  pickMarket,
  type RehearsalArgs,
  type RehearsalState,
  serializeState,
  TRADER_MIN_LAMPORTS,
  TRADER_USDC_BASE_UNITS,
} from "./rehearsal-plan";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const CLI = resolve(ROOT, "services/automation/src/cli/create-markets.ts");
const TRADER_NAMES = ["trader-a", "trader-b"] as const;
const TRADER_SOL_LAMPORTS = 100_000_000;
const SETTLE_PRICE_CENTS = 70_000n;
const STRIKE_CENTS_TO_SCALED = 10n ** 16n;
const BOOK_SIDE_BYTES = 32 * 64;

const envSchema = z.object({
  SOLANA_CLUSTER: z.enum(["devnet", "localnet"]),
  SOLANA_RPC_URL: z.string().url(),
  ADMIN_KEYPAIR_PATH: z.string().min(1),
  FAUCET_KEYPAIR: z.string().optional(),
  FAUCET_URL: z.string().url().optional(),
  ANCHOR_WALLET: z.string().optional(),
  MERIDIAN_PROGRAM_ID: z.string().optional(),
});
type Env = z.infer<typeof envSchema>;

const secretKey = z.array(z.number().int().min(0).max(255));
const loadKeypair = (json: string): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(secretKey.parse(JSON.parse(json))));

type Ctx = {
  readonly args: RehearsalArgs;
  readonly env: Env;
  readonly cluster: "devnet" | "localnet";
  readonly connection: Connection;
  readonly admin: Keypair;
  readonly programId: PublicKey;
  readonly program: Program<Meridian>;
  readonly provider: AnchorProvider;
  readonly stateDir: string;
};

type Trader = {
  readonly name: string;
  readonly keypair: Keypair;
  readonly usdc: PublicKey;
  readonly yes: PublicKey;
  readonly no: PublicKey;
};

let stepNo = 0;
async function step<T>(ctx: Ctx, name: string, run: (sigs: string[]) => Promise<T>): Promise<T> {
  stepNo += 1;
  const sigs: string[] = [];
  const result = await run(sigs);
  console.log(
    `[step ${stepNo}] ${name}${sigs.map((s) => `\n          tx ${explorerUrl(ctx.cluster, s)}`).join("")}`,
  );
  return result;
}

async function send(ctx: Ctx, tx: Transaction, signers: Keypair[], sigs: string[]): Promise<void> {
  sigs.push(await ctx.provider.sendAndConfirm(tx, signers, { commitment: "confirmed" }));
}

const amount = async (ctx: Ctx, account: PublicKey): Promise<bigint> =>
  BigInt((await ctx.connection.getTokenAccountBalance(account, "confirmed")).value.amount);

async function chainTime(ctx: Ctx): Promise<number> {
  const time = await ctx.connection.getBlockTime(await ctx.connection.getSlot("confirmed"));
  if (time === null) throw new Error("cluster returned no block time");
  return time;
}

// ---- setup ------------------------------------------------------------------------------------

async function setup(args: RehearsalArgs, environment: NodeJS.ProcessEnv): Promise<Ctx> {
  const env = envSchema.parse(environment);
  const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
  // The first thing that happens, before any key is read or transaction built.
  const cluster = await assertCluster({
    cluster: env.SOLANA_CLUSTER,
    rpcUrl: env.SOLANA_RPC_URL,
    getGenesisHash: () => connection.getGenesisHash(),
  });
  if (args.localSettle && cluster !== "localnet") {
    throw new Error("--local-settle (the local oracle) is only allowed on a local validator");
  }
  const admin = loadKeypair(readFileSync(env.ADMIN_KEYPAIR_PATH, "utf8"));
  const programId =
    env.MERIDIAN_PROGRAM_ID === undefined
      ? MERIDIAN_PROGRAM_ID
      : new PublicKey(env.MERIDIAN_PROGRAM_ID);
  const provider = new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" });
  return {
    args,
    env,
    cluster,
    connection,
    admin,
    programId,
    provider,
    program: createMeridianProgram(provider, programId),
    stateDir: resolve(args.stateDir ?? resolve(ROOT, "target/rehearsal")),
  };
}

// ---- markets fallback -------------------------------------------------------------------------

function runMarketsFallback(ctx: Ctx): void {
  const { prevCloses } = ctx.args;
  const wallet = ctx.env.ANCHOR_WALLET;
  if (prevCloses === undefined || wallet === undefined) {
    throw new Error(
      "--phase markets needs --prev-closes and ANCHOR_WALLET (automation keypair file)",
    );
  }
  const out = execFileSync(
    "pnpm",
    [
      "--filter",
      "automation",
      "exec",
      "tsx",
      CLI,
      "--prev-closes",
      prevCloses,
      "--program-id",
      ctx.programId.toBase58(),
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ANCHOR_PROVIDER_URL: ctx.env.SOLANA_RPC_URL, ANCHOR_WALLET: wallet },
    },
  );
  console.log(
    out
      .split("\n")
      .map((line) => {
        const created = /^created (\S+) (\d+) (\S+)$/.exec(line);
        return created === null
          ? line
          : `created ${created[1]} ${created[2]} ${explorerUrl(ctx.cluster, created[3] ?? "")}`;
      })
      .join("\n"),
  );
}

// ---- trade phase ------------------------------------------------------------------------------

async function listMarkets(ctx: Ctx): Promise<MarketRow[]> {
  const all = await ctx.program.account.market.all();
  return all.map(({ publicKey, account }) => ({
    address: publicKey.toBase58(),
    symbol: symbolFromBytes(account.ticker),
    strikeCents: BigInt(account.strikeCents.toString()),
    closeTs: Number(account.closeTs.toString()),
    open: "open" in account.status,
    pairsOutstanding: BigInt(account.pairsOutstanding.toString()),
  }));
}

function addressesOf(ctx: Ctx, row: { symbol: string; strikeCents: bigint }, date: number) {
  return marketAddresses(
    { symbol: row.symbol, tradingDate: date, strikeCents: row.strikeCents },
    ctx.programId,
  );
}

function loadOrCreateTrader(ctx: Ctx, name: string): Keypair {
  mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
  const path = resolve(ctx.stateDir, `${name}.json`);
  if (existsSync(path)) return loadKeypair(readFileSync(path, "utf8"));
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return keypair;
}

async function tradersFor(ctx: Ctx, a: MarketAddresses, usdcMint: PublicKey): Promise<Trader[]> {
  const traders: Trader[] = [];
  for (const name of TRADER_NAMES) {
    const keypair = loadOrCreateTrader(ctx, name);
    const owner = keypair.publicKey;
    traders.push({
      name,
      keypair,
      usdc: getAssociatedTokenAddressSync(usdcMint, owner),
      yes: getAssociatedTokenAddressSync(a.yesMint, owner),
      no: getAssociatedTokenAddressSync(a.noMint, owner),
    });
  }
  return traders;
}

async function fundTraders(ctx: Ctx, traders: Trader[], usdcMint: PublicKey): Promise<void> {
  const { admin, connection } = ctx;
  if (ctx.args.fund === "direct") {
    const faucetJson = ctx.env.FAUCET_KEYPAIR;
    if (faucetJson === undefined) {
      throw new Error("--fund direct needs FAUCET_KEYPAIR (the test-USDC mint authority)");
    }
    const faucet = loadKeypair(faucetJson);
    const mint = await getMint(connection, usdcMint);
    if (mint.mintAuthority === null || !mint.mintAuthority.equals(faucet.publicKey)) {
      throw new Error("FAUCET_KEYPAIR is not the mint authority of the Config's USDC mint");
    }
    await step(ctx, "fund trader-a and trader-b directly (SOL + 1,000 test-USDC)", async (sigs) => {
      for (const trader of traders) {
        const have = BigInt(await connection.getBalance(trader.keypair.publicKey, "confirmed"));
        if (have < TRADER_MIN_LAMPORTS) {
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: admin.publicKey,
              toPubkey: trader.keypair.publicKey,
              lamports: TRADER_SOL_LAMPORTS,
            }),
          );
          await send(ctx, tx, [admin], sigs);
        }
        await createAssociatedTokenAccountIdempotent(
          connection,
          admin,
          usdcMint,
          trader.keypair.publicKey,
        );
        const usdc = await amount(ctx, trader.usdc);
        if (usdc < TRADER_USDC_BASE_UNITS) {
          sigs.push(
            await mintTo(
              connection,
              admin,
              usdcMint,
              trader.usdc,
              faucet,
              TRADER_USDC_BASE_UNITS - usdc,
            ),
          );
        }
      }
    });
    return;
  }
  if (ctx.args.fund === "faucet") {
    const faucetUrl = ctx.env.FAUCET_URL;
    if (faucetUrl === undefined) {
      throw new Error(
        "--fund faucet needs FAUCET_URL (the app, e.g. http://localhost:3000); or use --fund direct / none",
      );
    }
    await step(
      ctx,
      "fund trader-a and trader-b: SOL from the admin, test-USDC from the faucet",
      async (sigs) => {
        for (const trader of traders) {
          const have = BigInt(await connection.getBalance(trader.keypair.publicKey, "confirmed"));
          if (have < TRADER_MIN_LAMPORTS) {
            const tx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: admin.publicKey,
                toPubkey: trader.keypair.publicKey,
                lamports: TRADER_SOL_LAMPORTS,
              }),
            );
            await send(ctx, tx, [admin], sigs);
          }
          if (
            (await connection.getAccountInfo(trader.usdc, "confirmed")) === null ||
            (await amount(ctx, trader.usdc)) < TRADER_USDC_BASE_UNITS
          ) {
            const claim = await claimFromFaucet(
              fetch,
              faucetUrl,
              trader.keypair.publicKey.toBase58(),
            );
            if (claim.kind === "claimed") sigs.push(claim.signature);
          }
        }
      },
    );
    for (const trader of traders) {
      assertFunded(
        trader.name,
        {
          lamports: BigInt(await connection.getBalance(trader.keypair.publicKey, "confirmed")),
          usdc:
            (await connection.getAccountInfo(trader.usdc, "confirmed")) === null
              ? 0n
              : await amount(ctx, trader.usdc),
        },
        "the faucet allows one claim per wallet per 24 h (and may mint less than 1,000): top the wallet up by hand or use --fund direct",
      );
    }
    return;
  }
  // Manual funding (the faucet button of M2-09, or any mint-authority holder): the script only
  // prints the wallets and checks the balances.
  for (const trader of traders) {
    await createAssociatedTokenAccountIdempotent(
      connection,
      admin,
      usdcMint,
      trader.keypair.publicKey,
    );
    console.log(`${trader.name} wallet ${trader.keypair.publicKey.toBase58()}`);
  }
  for (const trader of traders) {
    assertFunded(
      trader.name,
      {
        lamports: BigInt(await connection.getBalance(trader.keypair.publicKey, "confirmed")),
        usdc: await amount(ctx, trader.usdc),
      },
      "send each wallet at least 0.03 SOL and claim or mint 1,000 test-USDC to it, then re-run",
    );
  }
}

async function restingTotals(ctx: Ctx, book: PublicKey) {
  const info = await ctx.connection.getAccountInfo(book, "confirmed");
  if (info === null) throw new Error("book account missing");
  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  let bidNotional = 0n;
  let askQty = 0n;
  for (let i = 0; i < 32; i += 1) {
    const bid = 8 + i * 64;
    const ask = 8 + BOOK_SIDE_BYTES + i * 64;
    bidNotional +=
      view.getBigUint64(bid + 48, true) * BigInt(view.getUint8(bid + 40)) * UNITS_PER_CENT;
    askQty += view.getBigUint64(ask + 48, true);
  }
  return { bidNotional, askQty };
}

/** Vault = 1 USDC x pairs and supply = pairs (domain.md invariants), plus the escrow rule. */
async function assertInvariants(
  ctx: Ctx,
  a: MarketAddresses,
  traders: readonly Trader[],
  label: string,
): Promise<void> {
  const market = await ctx.program.account.market.fetch(a.market);
  const pairs = BigInt(market.pairsOutstanding.toString());
  const fail = (what: string): never => {
    throw new Error(`invariant broken after "${label}": ${what}`);
  };
  if ((await amount(ctx, a.vault)) !== pairs * UNITS_PER_USDC) fail("vault != 1 USDC x pairs");
  if (!("settled" in market.status)) {
    const supply = async (mint: PublicKey) =>
      BigInt((await ctx.connection.getTokenSupply(mint, "confirmed")).value.amount);
    if ((await supply(a.yesMint)) !== pairs || (await supply(a.noMint)) !== pairs) {
      fail("YES/NO supply != pairs outstanding");
    }
    let freeUsdc = 0n;
    let freeYes = 0n;
    for (const trader of traders) {
      const oo = await ctx.program.account.openOrders.fetchNullable(
        findOpenOrdersPda(a.market, trader.keypair.publicKey, ctx.programId).address,
      );
      if (oo !== null) {
        freeUsdc += BigInt(oo.freeUsdc.toString());
        freeYes += BigInt(oo.freeYes.toString());
      }
    }
    const { bidNotional, askQty } = await restingTotals(ctx, a.book);
    if ((await amount(ctx, a.escrowUsdc)) !== bidNotional + freeUsdc) fail("escrow USDC mismatch");
    if ((await amount(ctx, a.escrowYes)) !== askQty + freeYes) fail("escrow YES mismatch");
  }
}

async function runTrade(ctx: Ctx): Promise<void> {
  const statePath = resolve(ctx.stateDir, "state.json");
  if (existsSync(statePath)) {
    throw new Error(
      `${statePath} exists: this rehearsal already traded. Run --phase redeem, or pass a fresh --state-dir`,
    );
  }
  const config = await ctx.program.account.config.fetch(findConfigPda(ctx.programId).address);
  const usdcMint = config.usdcMint;
  const row = pickMarket(await listMarkets(ctx), ctx.args, await chainTime(ctx));
  const market = await ctx.program.account.market.fetch(new PublicKey(row.address));
  const addresses = addressesOf(ctx, row, market.tradingDate);
  if (addresses.market.toBase58() !== row.address) {
    throw new Error("market address does not match its seeds; refusing to trade");
  }
  console.log(
    `market ${row.symbol} strike $${Number(row.strikeCents) / 100} ${row.address} closes ${new Date(row.closeTs * 1000).toISOString()}`,
  );
  const { bidNotional, askQty } = await restingTotals(ctx, addresses.book);
  if (bidNotional !== 0n || askQty !== 0n || row.pairsOutstanding !== 0n) {
    throw new Error("the book/market is not empty: pick another --symbol/--strike-cents");
  }

  const traders = await tradersFor(ctx, addresses, usdcMint);
  await fundTraders(ctx, traders, usdcMint);
  await step(ctx, "create the traders' YES/NO token accounts", async () => {
    for (const trader of traders) {
      for (const mint of [addresses.yesMint, addresses.noMint]) {
        const before = await ctx.connection.getAccountInfo(
          getAssociatedTokenAddressSync(mint, trader.keypair.publicKey),
          "confirmed",
        );
        if (before === null) {
          await createAssociatedTokenAccountIdempotent(
            ctx.connection,
            ctx.admin,
            mint,
            trader.keypair.publicKey,
          );
        }
      }
    }
  });
  const [a, b] = traders;
  if (a === undefined || b === undefined) throw new Error("traders missing");
  const startUsdc: Record<string, string> = {};
  for (const trader of traders)
    startUsdc[trader.name] = (await amount(ctx, trader.usdc)).toString();
  const ledger = new Ledger([a.name, b.name]);
  const check = (label: string) => assertInvariants(ctx, addresses, traders, label);
  await check("funding");

  const trade = async (
    who: Trader,
    intent: Intent,
    kind: OrderKindName,
    priceCents: number,
    qty: bigint,
    makers: readonly Trader[],
    sigs: string[],
  ) => {
    const ix = await buildTrade({
      program: ctx.program,
      intent,
      kind,
      priceCents,
      qty,
      accounts: {
        user: who.keypair.publicKey,
        userUsdc: who.usdc,
        userYes: who.yes,
        userNo: who.no,
        market: addresses,
      },
      makers: makers.map((m) => m.keypair.publicKey),
    });
    await send(ctx, new Transaction().add(ix), [who.keypair], sigs);
  };

  await step(ctx, "trader-b mints 20 pairs", async (sigs) => {
    sigs.push(
      await ctx.program.methods
        .mintPair(new BN(20))
        .accountsStrict({
          config: findConfigPda(ctx.programId).address,
          market: addresses.market,
          user: b.keypair.publicKey,
          userUsdc: b.usdc,
          userYes: b.yes,
          userNo: b.no,
          yesMint: addresses.yesMint,
          noMint: addresses.noMint,
          vault: addresses.vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([b.keypair])
        .rpc({ commitment: "confirmed" }),
    );
    ledger.mintPairs(b.name, 20n);
  });
  await check("mint");
  await step(ctx, "SELL YES: trader-b rests 10 @ 60¢", (sigs) =>
    trade(b, "SELL_YES", "limit", 60, 10n, [], sigs),
  );
  await check("sell yes (rest)");
  await step(ctx, "BUY YES: trader-a buys 10 @ 60¢ (IOC)", async (sigs) => {
    await trade(a, "BUY_YES", "ioc", 60, 10n, [b], sigs);
    ledger.trade(a.name, b.name, 60n, 10n);
  });
  await check("buy yes");
  await step(
    ctx,
    "SELL YES: trader-b bids 4 @ 55¢, trader-a sells 4 into it (IOC)",
    async (sigs) => {
      await trade(b, "BUY_YES", "limit", 55, 4n, [], sigs);
      await trade(a, "SELL_YES", "ioc", 55, 4n, [b], sigs);
      ledger.trade(b.name, a.name, 55n, 4n);
    },
  );
  await check("sell yes");
  await step(
    ctx,
    "BUY NO: trader-b bids 3 @ 45¢, trader-a buys 3 NO at 55¢ (IOC)",
    async (sigs) => {
      await trade(b, "BUY_YES", "limit", 45, 3n, [], sigs);
      await trade(a, "BUY_NO", "ioc", 55, 3n, [b], sigs);
      ledger.mintPairs(a.name, 3n);
      ledger.trade(b.name, a.name, 45n, 3n);
    },
  );
  await check("buy no");
  await step(ctx, "SELL NO: trader-b asks 1 @ 70¢, trader-a sells 1 NO (IOC)", async (sigs) => {
    await trade(b, "SELL_YES", "limit", 70, 1n, [], sigs);
    await trade(a, "SELL_NO", "ioc", 1, 1n, [b], sigs);
    ledger.trade(a.name, b.name, 70n, 1n);
    ledger.redeemPairs(a.name, 1n);
  });
  await check("sell no");

  const holdings: RehearsalState["holdings"] = {};
  for (const trader of traders) {
    const h = ledger.get(trader.name);
    holdings[trader.name] = { cash: h.cash.toString(), yes: h.yes.toString(), no: h.no.toString() };
    for (const [token, expected] of [
      [trader.yes, h.yes],
      [trader.no, h.no],
    ] as const) {
      // Maker fills sit in the open-orders account until settle_funds, so only a lower bound here.
      if ((await amount(ctx, token)) > expected) {
        throw new Error(`${trader.name} holds more tokens than the model allows`);
      }
    }
  }
  mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    statePath,
    serializeState({
      programId: ctx.programId.toBase58(),
      market: row.address,
      symbol: row.symbol,
      strikeCents: row.strikeCents.toString(),
      tradingDate: market.tradingDate,
      closeTs: row.closeTs,
      traders: traders.map((t) => ({ name: t.name, pubkey: t.keypair.publicKey.toBase58() })),
      startUsdc,
      holdings,
    }),
  );
  console.log(
    `trade phase ok. State in ${statePath}. After the 16:05 ET settlement run: --cluster devnet --phase redeem`,
  );
}

// ---- redeem phase -----------------------------------------------------------------------------

function localFeedPda(ctx: Ctx, symbol: string, slot: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("local_feed"), symbolBytes(symbol), Buffer.from([slot])],
    ctx.programId,
  )[0];
}

/** Local validator only: wait for close, report $700 from both local feeds and settle. */
async function settleLocally(ctx: Ctx, state: RehearsalState, a: MarketAddresses): Promise<void> {
  while ((await chainTime(ctx)) < state.closeTs) {
    await new Promise((r) => setTimeout(r, 1_000));
  }
  await step(ctx, "local oracle: both sources report $700.00; settle_market", async (sigs) => {
    const value = new BN((SETTLE_PRICE_CENTS * STRIKE_CENTS_TO_SCALED).toString());
    for (const slot of [0, 1]) {
      sigs.push(
        await ctx.program.methods
          .localOracleSet(
            Array.from(symbolBytes(state.symbol)),
            slot,
            value,
            new BN(await ctx.connection.getSlot("confirmed")),
          )
          .accountsStrict({
            config: findConfigPda(ctx.programId).address,
            localFeed: localFeedPda(ctx, state.symbol, slot),
            admin: ctx.admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" }),
      );
    }
    sigs.push(
      await ctx.program.methods
        .settleMarket()
        .accountsStrict({
          config: findConfigPda(ctx.programId).address,
          market: a.market,
          feedTiingo: localFeedPda(ctx, state.symbol, 0),
          feedTwelveData: localFeedPda(ctx, state.symbol, 1),
          payer: ctx.admin.publicKey,
        })
        .rpc({ commitment: "confirmed" }),
    );
  });
}

async function runRedeem(ctx: Ctx): Promise<void> {
  const state = parseState(readFileSync(resolve(ctx.stateDir, "state.json"), "utf8"));
  if (state.programId !== ctx.programId.toBase58()) {
    throw new Error("the saved state is for another program; use a fresh --state-dir");
  }
  const addresses = addressesOf(
    ctx,
    { symbol: state.symbol, strikeCents: BigInt(state.strikeCents) },
    state.tradingDate,
  );
  if (addresses.market.toBase58() !== state.market) throw new Error("state/market mismatch");
  if (ctx.args.localSettle) {
    await settleLocally(ctx, state, addresses);
  }
  let market = await ctx.program.account.market.fetch(addresses.market);
  if (!("settled" in market.status)) {
    const secs = state.closeTs - (await chainTime(ctx));
    throw new Error(
      `the market is not settled yet (closes ${secs > 0 ? `in ${secs}s` : `${-secs}s ago`}); ` +
        "settlement is automatic after the close: see the runbook before diagnosing it",
    );
  }
  market = await ctx.program.account.market.fetch(addresses.market);
  const yesWins = "yes" in market.outcome;
  console.log(`market settled: ${yesWins ? "YES" : "NO"} wins`);

  const config = await ctx.program.account.config.fetch(findConfigPda(ctx.programId).address);
  const traders: Trader[] = state.traders.map(({ name }) => {
    const keypair = loadOrCreateTrader(ctx, name);
    return {
      name,
      keypair,
      usdc: getAssociatedTokenAddressSync(config.usdcMint, keypair.publicKey),
      yes: getAssociatedTokenAddressSync(addresses.yesMint, keypair.publicKey),
      no: getAssociatedTokenAddressSync(addresses.noMint, keypair.publicKey),
    };
  });
  for (const [index, trader] of traders.entries()) {
    if (state.traders[index]?.pubkey !== trader.keypair.publicKey.toBase58()) {
      throw new Error(`${trader.name}'s keypair does not match the saved state`);
    }
  }
  await step(ctx, "settle_funds for both traders", async (sigs) => {
    for (const trader of traders) {
      sigs.push(
        await ctx.program.methods
          .settleFunds()
          .accountsStrict({
            market: addresses.market,
            owner: trader.keypair.publicKey,
            openOrders: findOpenOrdersPda(addresses.market, trader.keypair.publicKey, ctx.programId)
              .address,
            escrowUsdc: addresses.escrowUsdc,
            escrowYes: addresses.escrowYes,
            userUsdc: trader.usdc,
            userYes: trader.yes,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([trader.keypair])
          .rpc({ commitment: "confirmed" }),
      );
    }
  });
  for (const trader of traders) {
    const expected = state.holdings[trader.name];
    if (
      expected === undefined ||
      (await amount(ctx, trader.yes)) !== BigInt(expected.yes) ||
      (await amount(ctx, trader.no)) !== BigInt(expected.no)
    ) {
      throw new Error(`${trader.name}'s YES/NO balances differ from the model after settle_funds`);
    }
  }
  await step(ctx, "redeem for both traders", async (sigs) => {
    for (const trader of traders) {
      sigs.push(
        await ctx.program.methods
          .redeem(
            new BN((await amount(ctx, trader.yes)).toString()),
            new BN((await amount(ctx, trader.no)).toString()),
          )
          .accountsStrict({
            market: addresses.market,
            user: trader.keypair.publicKey,
            userUsdc: trader.usdc,
            userYes: trader.yes,
            userNo: trader.no,
            yesMint: addresses.yesMint,
            noMint: addresses.noMint,
            vault: addresses.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([trader.keypair])
          .rpc({ commitment: "confirmed" }),
      );
    }
  });
  let sum = 0n;
  for (const trader of traders) {
    const holding = state.holdings[trader.name];
    const start = state.startUsdc[trader.name];
    if (holding === undefined || start === undefined) throw new Error("state is incomplete");
    const change = (await amount(ctx, trader.usdc)) - BigInt(start);
    const expected = expectedCashChange(holding, yesWins);
    console.log(`${trader.name}: USDC change ${change} base units, expected ${expected}`);
    if (change !== expected) {
      throw new Error(`${trader.name} P&L ${change} != independent model ${expected}`);
    }
    sum += change;
  }
  if (sum !== 0n) throw new Error(`traders' P&L must net to zero, got ${sum}`);
  console.log("redeem phase ok: record the explorer links above in docs/log.md");
}

/** Rethrows with the RPC URL (which may carry an API key) removed from the message. */
function redacted(error: unknown, rpcUrl: string | undefined): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(rpcUrl === undefined || rpcUrl === "" ? message : redactRpcUrl(message, rpcUrl));
}

export async function runRehearsal(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const args = parseRehearsalArgs(argv);
  const rpcUrl = environment.SOLANA_RPC_URL;
  // Setup (env parsing, the cluster guard) is inside the redaction too: a failed parse or a
  // fetch error can echo the URL.
  try {
    const ctx = await setup(args, environment);
    if (args.phase === "markets") runMarketsFallback(ctx);
    else if (args.phase === "trade") await runTrade(ctx);
    else await runRedeem(ctx);
  } catch (error) {
    throw redacted(error, rpcUrl);
  }
}
