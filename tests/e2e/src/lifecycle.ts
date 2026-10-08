/**
 * The demo path, scripted (M1-10): on the target cluster, initialise the config with local
 * oracle feeds, create the day's markets with the `create-markets` CLI (twice: the second run
 * must create nothing), fund two traders, run Buy YES, Sell YES, Buy NO and Sell NO through the
 * client's `buildTrade`, wait past close, set local oracle values, settle, settle funds and
 * redeem. The vault and escrow invariants are asserted after every step, and each trader's
 * final USDC change must equal the independent model in `ledger.ts` exactly.
 *
 * Environment (set by scripts/e2e.sh): ANCHOR_PROVIDER_URL, ANCHOR_WALLET (admin + automation
 * authority + payer), E2E_PROGRAM_ID. Optional: E2E_CLOSE_IN_SECS (default 150),
 * E2E_SEED_ONLY=1 (stop after the markets exist; used by `make dev`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AnchorProvider, type Program, Wallet } from "@coral-xyz/anchor";
import {
  BN,
  buildTrade,
  configParamsArg,
  configParamsBatches,
  createMeridianProgram,
  findConfigPda,
  findOpenOrdersPda,
  type Intent,
  marketAddresses,
  type MarketAddresses,
  type Meridian,
  type OrderKindName,
  symbolBytes,
  type TickerInput,
} from "@meridian/client";
import {
  createAccount,
  createAssociatedTokenAccountIdempotent,
  createMint,
  mintTo,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { z } from "zod";

import {
  chainMarketOps,
  fakeSourcesHttp,
  fetchPrevClose,
  RunState,
  runMorning,
  silentLogger,
} from "automation";

import { Ledger, UNITS_PER_CENT, UNITS_PER_USDC } from "./ledger";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const FIXTURE = resolve(ROOT, "tests/fixtures/prev_closes.json");
const CLI = resolve(ROOT, "services/automation/src/cli/create-markets.ts");
const TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
const TRADED = { symbol: "META", strikeCents: 68_000n } as const;
/** Settlement price: $700.00, at or above the $680 strike, so YES wins. */
const SETTLE_PRICE_CENTS = 70_000n;
const STRIKE_CENTS_TO_SCALED = 10n ** 16n;

const env = z
  .object({
    ANCHOR_PROVIDER_URL: z.string().url(),
    ANCHOR_WALLET: z.string().min(1),
    E2E_PROGRAM_ID: z.string().min(32),
    E2E_CLOSE_IN_SECS: z.coerce.number().int().positive().default(150),
    E2E_SEED_ONLY: z.string().optional(),
  })
  .parse(process.env);

const connection = new Connection(env.ANCHOR_PROVIDER_URL, "confirmed");
const admin = Keypair.fromSecretKey(
  Uint8Array.from(
    z
      .array(z.number().int().min(0).max(255))
      .parse(JSON.parse(readFileSync(env.ANCHOR_WALLET, "utf8"))),
  ),
);
const programId = new PublicKey(env.E2E_PROGRAM_ID);
const provider = new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" });
const program: Program<Meridian> = createMeridianProgram(provider, programId);

let stepNo = 0;
function say(message: string): void {
  console.log(message);
}
/** Runs one named step and prints it with the signatures it produced. */
async function step<T>(name: string, run: (sigs: string[]) => Promise<T>): Promise<T> {
  stepNo += 1;
  const sigs: string[] = [];
  const result = await run(sigs);
  say(`[step ${stepNo}] ${name}${sigs.map((s) => `\n          tx ${s}`).join("")}`);
  return result;
}

// ---- chain helpers ----------------------------------------------------------------------------

function localFeedPda(symbol: string, sourceSlot: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("local_feed"), symbolBytes(symbol), Buffer.from([sourceSlot])],
    programId,
  )[0];
}

async function send(tx: Transaction, signers: Keypair[], sigs: string[]): Promise<string> {
  const signature = await provider.sendAndConfirm(tx, signers, { commitment: "confirmed" });
  sigs.push(signature);
  return signature;
}

async function chainTime(): Promise<number> {
  const time = await connection.getBlockTime(await connection.getSlot("confirmed"));
  if (time === null) {
    throw new Error("cluster returned no block time");
  }
  return time;
}

async function amount(account: PublicKey): Promise<bigint> {
  return BigInt((await connection.getTokenAccountBalance(account, "confirmed")).value.amount);
}

async function supply(mint: PublicKey): Promise<bigint> {
  return BigInt((await connection.getTokenSupply(mint, "confirmed")).value.amount);
}

type Trader = {
  readonly name: string;
  readonly keypair: Keypair;
  readonly usdc: PublicKey;
  readonly yes: PublicKey;
  readonly no: PublicKey;
};

// ---- invariants -------------------------------------------------------------------------------

const BOOK_SIDE_BYTES = 32 * 64;

/** Σ price × qty (USDC base units) of resting bids and Σ qty of resting asks, parsed from the raw book. */
async function restingTotals(book: PublicKey): Promise<{ bidNotional: bigint; askQty: bigint }> {
  const info = await connection.getAccountInfo(book, "confirmed");
  if (info === null) {
    throw new Error("book account missing");
  }
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

/** Vault, supply and escrow invariants (domain.md invariants 1, 3 and the D-029 escrow rule). */
async function assertInvariants(a: MarketAddresses, traders: readonly Trader[], label: string) {
  const market = await program.account.market.fetch(a.market);
  const pairs = BigInt(market.pairsOutstanding.toString());
  const fail = (what: string): never => {
    throw new Error(`invariant broken after "${label}": ${what}`);
  };
  if ((await amount(a.vault)) !== pairs * UNITS_PER_USDC) {
    fail("vault != 1 USDC x pairs outstanding");
  }
  if (!("settled" in market.status)) {
    if ((await supply(a.yesMint)) !== pairs || (await supply(a.noMint)) !== pairs) {
      fail("YES/NO supply != pairs outstanding");
    }
  }
  let freeUsdc = 0n;
  let freeYes = 0n;
  for (const trader of traders) {
    const oo = await program.account.openOrders.fetchNullable(
      findOpenOrdersPda(a.market, trader.keypair.publicKey, programId).address,
    );
    if (oo !== null) {
      freeUsdc += BigInt(oo.freeUsdc.toString());
      freeYes += BigInt(oo.freeYes.toString());
    }
  }
  const { bidNotional, askQty } = await restingTotals(a.book);
  if ((await amount(a.escrowUsdc)) !== bidNotional + freeUsdc) {
    fail("escrow USDC != resting bids + free USDC");
  }
  if ((await amount(a.escrowYes)) !== askQty + freeYes) {
    fail("escrow YES != resting asks + free YES");
  }
}

// ---- main -------------------------------------------------------------------------------------

async function createMarketsViaCli(sigs: string[]): Promise<{ created: number; existed: number }> {
  const out = execFileSync(
    "pnpm",
    [
      "--filter",
      "automation",
      "exec",
      "tsx",
      CLI,
      "--prev-closes",
      FIXTURE,
      "--close-in-secs",
      String(closeInSecs),
      "--program-id",
      programId.toBase58(),
    ],
    { cwd: ROOT, encoding: "utf8", env: process.env },
  );
  // The CLI prints `created <symbol> <strike> <signature>` per market; surface the signatures.
  for (const line of out.split("\n")) {
    const created = /^created (\S+) (\d+) (\S+)$/.exec(line);
    if (created !== null) {
      sigs.push(`${created[3]}  (${created[1]} $${Number(created[2]) / 100})`);
    }
  }
  const match = /(\d+) created, (\d+) already existed/.exec(out);
  if (match === null) {
    throw new Error(`unexpected create-markets output:\n${out}`);
  }
  return { created: Number(match[1]), existed: Number(match[2]) };
}

/**
 * `make dev`: two persisted local wallets (`trader-a`, `trader-b`) with SOL and 10,000 test-USDC
 * each, so a browser wallet can import one of the keypairs and trade (docs/environment.md).
 * The keypairs are throwaway local-validator keys under `target/` (gitignored); an existing
 * file is reused so the imported wallet stays the same across `make dev` runs.
 */
async function fundDevWallets(usdcMint: PublicKey): Promise<void> {
  const dir = resolve(ROOT, "target/dev-wallets");
  mkdirSync(dir, { recursive: true });
  for (const name of ["trader-a", "trader-b"]) {
    const path = resolve(dir, `${name}.json`);
    const keypair = existsSync(path)
      ? Keypair.fromSecretKey(
          Uint8Array.from(
            z.array(z.number().int().min(0).max(255)).parse(JSON.parse(readFileSync(path, "utf8"))),
          ),
        )
      : Keypair.generate();
    if (!existsSync(path)) {
      writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
    }
    const transfer = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: keypair.publicKey,
        lamports: 5_000_000_000,
      }),
    );
    const sigs: string[] = [];
    await send(transfer, [admin], sigs);
    const account = await createAssociatedTokenAccountIdempotent(
      connection,
      admin,
      usdcMint,
      keypair.publicKey,
    );
    await mintTo(connection, admin, usdcMint, account, admin, 10_000n * UNITS_PER_USDC);
    say(
      `funded ${name} ${keypair.publicKey.toBase58()}: 5 SOL + 10,000 test-USDC (keypair ${path})`,
    );
  }
}

const closeInSecs = env.E2E_CLOSE_IN_SECS;

async function main(): Promise<void> {
  const started = Date.now();
  await step("program responds (version)", async (sigs) => {
    sigs.push(await program.methods.version().rpc({ commitment: "confirmed" }));
  });

  // ---- config with local feeds -----------------------------------------------------------------
  const usdcMint = await step("create test-USDC mint (6 decimals)", async () =>
    createMint(connection, admin, admin.publicKey, null, 6),
  );
  await step(
    "initialize_config (+ update_config for the 7th ticker), local feeds",
    async (sigs) => {
      // A local feed's "hash" is its own address (see `oracle::local_reading`).
      const tickers: TickerInput[] = TICKERS.map((symbol) => {
        const feeds: [PublicKey, PublicKey] = [localFeedPda(symbol, 0), localFeedPda(symbol, 1)];
        return { symbol, feeds, feedHashes: [feeds[0].toBytes(), feeds[1].toBytes()] };
      });
      const batches = configParamsBatches(
        {
          automationAuthority: admin.publicKey,
          maxStalenessSlots: 30n,
          maxConfBps: 5,
          overrideDelaySecs: 3_600n,
        },
        tickers,
      );
      const [first, ...rest] = batches;
      if (first === undefined) {
        throw new Error("no config batch");
      }
      const config = findConfigPda(programId).address;
      sigs.push(
        await program.methods
          .initializeConfig(configParamsArg(first))
          .accountsStrict({
            config,
            admin: admin.publicKey,
            usdcMint,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" }),
      );
      for (const batch of rest) {
        sigs.push(
          await program.methods
            .updateConfig(configParamsArg(batch))
            .accountsStrict({ config, admin: admin.publicKey, usdcMint })
            .rpc({ commitment: "confirmed" }),
        );
      }
    },
  );

  // ---- markets ---------------------------------------------------------------------------------
  const first = await step("create-markets CLI (first run)", async (sigs) =>
    createMarketsViaCli(sigs),
  );
  say(`          ${first.created} created, ${first.existed} already existed`);
  if (first.created === 0 || first.existed !== 0) {
    throw new Error("first create-markets run must create every market");
  }
  const second = await step("create-markets CLI (second run creates nothing)", async (sigs) =>
    createMarketsViaCli(sigs),
  );
  say(`          ${second.created} created, ${second.existed} already existed`);
  if (second.created !== 0 || second.existed !== first.created) {
    throw new Error("second create-markets run must create nothing (NFR-05)");
  }
  const marketCount = (await program.account.market.all()).length;
  if (marketCount !== first.created) {
    throw new Error(`expected ${first.created} market accounts, found ${marketCount}`);
  }
  const fixture = z
    .object({ tradingDate: z.string(), closes: z.record(z.string(), z.number()) })
    .parse(JSON.parse(readFileSync(FIXTURE, "utf8")));
  const addresses = marketAddresses(
    {
      symbol: TRADED.symbol,
      tradingDate: Number(fixture.tradingDate.replaceAll("-", "")),
      strikeCents: TRADED.strikeCents,
    },
    programId,
  );
  const market = await program.account.market.fetch(addresses.market);
  const closeTs = Number(market.closeTs.toString());

  // M2-03 AC2: the scheduled morning job, run against this validator for the day whose markets
  // the CLI just created, finds them all and creates nothing. Fixed clock (08:00 ET on the
  // trading date) and mocked data sources: no network.
  await step("morning job re-run on the same day creates nothing (NFR-05)", async () => {
    const alerts: string[] = [];
    const http = fakeSourcesHttp({ closes: fixture.closes, date: "2026-10-05" });
    const result = await runMorning({
      now: () => new Date("2026-10-06T12:00:00Z"),
      sleep: () => Promise.resolve(),
      prevClose: (ticker, date) =>
        fetchPrevClose(
          { http, tiingoApiKey: "test-key", twelveDataApiKey: "test-key" },
          ticker,
          date,
        ),
      marketOps: await chainMarketOps(
        program,
        new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        SystemProgram.programId,
      ),
      alerter: {
        send: (alert) => {
          alerts.push(alert.summary);
          return Promise.resolve(true);
        },
      },
      state: new RunState(),
      log: silentLogger,
    });
    if (result.status !== "ok" || result.created !== 0 || result.existed !== first.created) {
      throw new Error(`morning job re-run: ${JSON.stringify(result)}`);
    }
    if (alerts.length > 0 || (await program.account.market.all()).length !== marketCount) {
      throw new Error("morning job re-run must not alert or add markets");
    }
    say(`          ${result.created} created, ${result.existed} already existed`);
  });
  if (env.E2E_SEED_ONLY !== undefined) {
    await fundDevWallets(usdcMint);
    say(`seeded ${marketCount} markets for program ${programId.toBase58()}`);
    // Machine-readable: `scripts/e2e.sh --dev` hands this to the app as NEXT_PUBLIC_USDC_MINT.
    say(`SEED_USDC_MINT=${usdcMint.toBase58()}`);
    return;
  }

  // ---- traders ---------------------------------------------------------------------------------
  const traders: Trader[] = [];
  await step("fund trader-a and trader-b (SOL, 1,000 USDC, token accounts)", async (sigs) => {
    for (const name of ["trader-a", "trader-b"]) {
      const keypair = Keypair.generate();
      const transfer = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: keypair.publicKey,
          lamports: 2_000_000_000,
        }),
      );
      await send(transfer, [admin], sigs);
      const usdc = await createAccount(
        connection,
        admin,
        usdcMint,
        keypair.publicKey,
        Keypair.generate(),
      );
      const yes = await createAccount(
        connection,
        admin,
        addresses.yesMint,
        keypair.publicKey,
        Keypair.generate(),
      );
      const no = await createAccount(
        connection,
        admin,
        addresses.noMint,
        keypair.publicKey,
        Keypair.generate(),
      );
      sigs.push(await mintTo(connection, admin, usdcMint, usdc, admin, 1_000n * UNITS_PER_USDC));
      traders.push({ name, keypair, usdc, yes, no });
    }
  });
  const [a, b] = traders;
  if (a === undefined || b === undefined) {
    throw new Error("traders missing");
  }
  const startUsdc = new Map<string, bigint>();
  for (const trader of traders) {
    startUsdc.set(trader.name, await amount(trader.usdc));
  }
  const ledger = new Ledger([a.name, b.name]);
  const check = async (label: string) => assertInvariants(addresses, traders, label);
  await check("funding");

  const trade = async (
    who: Trader,
    intent: Intent,
    kind: OrderKindName,
    priceCents: number,
    qty: bigint,
    makers: readonly Trader[],
    sigs: string[],
  ): Promise<void> => {
    const ix = await buildTrade({
      program,
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
    await send(new Transaction().add(ix), [who.keypair], sigs);
  };

  // ---- trading ---------------------------------------------------------------------------------
  await step("trader-b mints 20 pairs", async (sigs) => {
    sigs.push(
      await program.methods
        .mintPair(new BN(20))
        .accountsStrict({
          config: findConfigPda(programId).address,
          market: addresses.market,
          user: b.keypair.publicKey,
          userUsdc: b.usdc,
          userYes: b.yes,
          userNo: b.no,
          yesMint: addresses.yesMint,
          noMint: addresses.noMint,
          vault: addresses.vault,
          tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        })
        .signers([b.keypair])
        .rpc({ commitment: "confirmed" }),
    );
    ledger.mintPairs(b.name, 20n);
  });
  await check("mint");

  await step("SELL YES: trader-b rests 10 @ 60¢", async (sigs) => {
    await trade(b, "SELL_YES", "limit", 60, 10n, [], sigs);
  });
  await check("sell yes (rest)");
  await step("BUY YES: trader-a buys 10 @ 60¢ (IOC)", async (sigs) => {
    await trade(a, "BUY_YES", "ioc", 60, 10n, [b], sigs);
    ledger.trade(a.name, b.name, 60n, 10n);
  });
  await check("buy yes");

  await step("SELL YES: trader-b bids 4 @ 55¢, trader-a sells 4 into it (IOC)", async (sigs) => {
    await trade(b, "BUY_YES", "limit", 55, 4n, [], sigs);
    await trade(a, "SELL_YES", "ioc", 55, 4n, [b], sigs);
    ledger.trade(b.name, a.name, 55n, 4n);
  });
  await check("sell yes");

  await step("BUY NO: trader-b bids 3 @ 45¢, trader-a buys 3 NO at 55¢ (IOC)", async (sigs) => {
    await trade(b, "BUY_YES", "limit", 45, 3n, [], sigs);
    await trade(a, "BUY_NO", "ioc", 55, 3n, [b], sigs);
    ledger.mintPairs(a.name, 3n);
    ledger.trade(b.name, a.name, 45n, 3n);
  });
  await check("buy no");

  await step(
    "SELL NO: trader-b asks 1 @ 70¢, trader-a sells 1 NO (IOC, worst NO price 1¢)",
    async (sigs) => {
      await trade(b, "SELL_YES", "limit", 70, 1n, [], sigs);
      await trade(a, "SELL_NO", "ioc", 1, 1n, [b], sigs);
      ledger.trade(a.name, b.name, 70n, 1n);
      ledger.redeemPairs(a.name, 1n);
    },
  );
  await check("sell no");

  await step("cancel: trader-b rests a bid @ 30¢ and cancels it", async (sigs) => {
    await trade(b, "BUY_YES", "limit", 30, 2n, [], sigs);
    const info = await connection.getAccountInfo(addresses.book, "confirmed");
    if (info === null) {
      throw new Error("book missing");
    }
    const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
    let orderId: bigint | undefined;
    for (let i = 0; i < 32; i += 1) {
      const slot = 8 + i * 64;
      if (view.getBigUint64(slot + 48, true) > 0n && view.getUint8(slot + 40) === 30) {
        orderId = view.getBigUint64(slot, true);
      }
    }
    if (orderId === undefined) {
      throw new Error("resting 30¢ bid not found on the book");
    }
    sigs.push(
      await program.methods
        .cancelOrder(new BN(orderId.toString()))
        .accountsStrict({
          market: addresses.market,
          book: addresses.book,
          owner: b.keypair.publicKey,
          openOrders: findOpenOrdersPda(addresses.market, b.keypair.publicKey, programId).address,
        })
        .signers([b.keypair])
        .rpc({ commitment: "confirmed" }),
    );
  });
  await check("cancel");

  // ---- close, oracle, settlement ---------------------------------------------------------------
  const now = await chainTime();
  if (now >= closeTs) {
    throw new Error(
      `trading took too long: the market closed ${now - closeTs}s ago; raise E2E_CLOSE_IN_SECS`,
    );
  }
  await step(`wait for close_ts (${closeTs - now}s)`, async () => {
    // The cluster clock follows its slots, so a loaded validator runs behind wall time. Keep
    // waiting while it advances; fail only when it stops for a full minute.
    const STALL_MS = 60_000;
    let last = now;
    let lastAdvance = Date.now();
    for (;;) {
      const current = await chainTime();
      if (current >= closeTs) {
        return;
      }
      if (current > last) {
        last = current;
        lastAdvance = Date.now();
      } else if (Date.now() - lastAdvance > STALL_MS) {
        throw new Error(
          `cluster clock stalled at ${current}, ${closeTs - current}s before close_ts`,
        );
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  });
  await step("AB-11: a new order after close is rejected", async () => {
    const outcome = await trade(a, "BUY_YES", "ioc", 60, 1n, [], []).then(
      () => "accepted",
      (error: unknown) => String(error),
    );
    if (outcome === "accepted") {
      throw new Error("an order after close must be rejected");
    }
    if (!/MarketClosed|Market is closed/.test(outcome)) {
      throw new Error(`expected MarketClosed, got ${outcome}`);
    }
  });

  await step("local oracle: both sources report $700.00; settle_market", async (sigs) => {
    const value = new BN((SETTLE_PRICE_CENTS * STRIKE_CENTS_TO_SCALED).toString());
    for (const slotIndex of [0, 1]) {
      sigs.push(
        await program.methods
          .localOracleSet(
            Array.from(symbolBytes(TRADED.symbol)),
            slotIndex,
            value,
            new BN(await connection.getSlot("confirmed")),
          )
          .accountsStrict({
            config: findConfigPda(programId).address,
            localFeed: localFeedPda(TRADED.symbol, slotIndex),
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" }),
      );
    }
    sigs.push(
      await program.methods
        .settleMarket()
        .accountsStrict({
          config: findConfigPda(programId).address,
          market: addresses.market,
          feedTiingo: localFeedPda(TRADED.symbol, 0),
          feedTwelveData: localFeedPda(TRADED.symbol, 1),
          payer: admin.publicKey,
        })
        .rpc({ commitment: "confirmed" }),
    );
  });
  const settled = await program.account.market.fetch(addresses.market);
  if (!("yes" in settled.outcome)) {
    throw new Error("a $700 close at a $680 strike must settle YES");
  }
  await check("settle");

  await step("settle_funds for both traders", async (sigs) => {
    for (const trader of traders) {
      sigs.push(
        await program.methods
          .settleFunds()
          .accountsStrict({
            market: addresses.market,
            owner: trader.keypair.publicKey,
            openOrders: findOpenOrdersPda(addresses.market, trader.keypair.publicKey, programId)
              .address,
            escrowUsdc: addresses.escrowUsdc,
            escrowYes: addresses.escrowYes,
            userUsdc: trader.usdc,
            userYes: trader.yes,
            tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          })
          .signers([trader.keypair])
          .rpc({ commitment: "confirmed" }),
      );
    }
  });
  await check("settle funds");

  for (const trader of traders) {
    const expected = ledger.get(trader.name);
    const chainYes = await amount(trader.yes);
    const chainNo = await amount(trader.no);
    if (chainYes !== expected.yes || chainNo !== expected.no) {
      throw new Error(
        `${trader.name} holds ${chainYes} YES / ${chainNo} NO, model says ${expected.yes} / ${expected.no}`,
      );
    }
  }

  await step("winner redeem for both traders (YES wins)", async (sigs) => {
    for (const trader of traders) {
      const yes = await amount(trader.yes);
      const no = await amount(trader.no);
      sigs.push(
        await program.methods
          .redeem(new BN(yes.toString()), new BN(no.toString()))
          .accountsStrict({
            market: addresses.market,
            user: trader.keypair.publicKey,
            userUsdc: trader.usdc,
            userYes: trader.yes,
            userNo: trader.no,
            yesMint: addresses.yesMint,
            noMint: addresses.noMint,
            vault: addresses.vault,
            tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          })
          .signers([trader.keypair])
          .rpc({ commitment: "confirmed" }),
      );
      ledger.redeemWinners(trader.name, true);
    }
  });
  await check("redeem");

  // ---- final balances (AC3: exact) -------------------------------------------------------------
  let sum = 0n;
  for (const trader of traders) {
    const change = (await amount(trader.usdc)) - (startUsdc.get(trader.name) ?? 0n);
    const expected = ledger.get(trader.name).cash;
    say(`${trader.name}: USDC change ${change} base units, expected ${expected}`);
    if (change !== expected) {
      throw new Error(`${trader.name} P&L ${change} != independent model ${expected}`);
    }
    sum += change;
  }
  if (sum !== 0n) {
    throw new Error(`traders' P&L must net to zero, got ${sum}`);
  }
  const final = await program.account.market.fetch(addresses.market);
  if (final.pairsOutstanding.toString() !== "0" || (await amount(addresses.vault)) !== 0n) {
    throw new Error("vault must be empty once every winning token is redeemed");
  }
  say(`lifecycle ok in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
