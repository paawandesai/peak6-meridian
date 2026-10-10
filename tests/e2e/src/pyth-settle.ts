/**
 * Pyth settlement on a local validator (D-055): `scripts/e2e.sh --pyth`.
 *
 * Calls the LIVE Pyth Lazer API with PYTH_API_TOKEN (from the repo-root `.env`), so it is not
 * part of `make e2e`. Nothing here touches devnet: the cluster is the throwaway validator that
 * `scripts/e2e.sh` starts, and the script refuses any other RPC.
 *
 * 1. Config with the MAG7 tickers, then `update_config` sets the official Pyth Lazer signer, the
 *    Pyth Pro feed ids and a 30 s close window, plus a 5 s override delay for step 6.
 * 2. AAPL markets for trading date 2026-10-09 closing a few seconds from now (create_strike_market
 *    needs a future close, so the recorded Friday 16:00 ET update is settled in LiteSVM instead).
 * 3. Once closed, Pyth's update signed at close_ts is fetched (the production request).
 * 4. Rejections with that real signed update, sent straight to the program (no off-chain check):
 *    wrong signer pinned, wrong feed pinned, update from before a market's close, update from
 *    after its close window, and confidence wider than max_conf_bps when the live width allows.
 * 5. The automation Pyth settler settles the two markets closing at T from the real update.
 * 6. The market Pyth could not settle is settled by admin_settle_override (the fallback).
 */
import { AnchorProvider, type Program, Wallet } from "@coral-xyz/anchor";
import {
  BN,
  configParamsArg,
  configParamsBatches,
  createMeridianProgram,
  findConfigPda,
  marketAddresses,
  type Meridian,
  PYTH_DISABLED,
  type PythConfigInput,
  type TickerInput,
} from "@meridian/client";
import { createMint } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  buildPythSettleInstructions,
  chainMarketOps,
  confidenceBps,
  connectionExecutor,
  createPythSettler,
  fetchSignedPrice,
  type OpenMarket,
  PYTH_FEED_IDS,
  PYTH_LAZER_URL,
  pythEd25519Ix,
  readPythConfig,
  type SignedPythUpdate,
} from "automation";
import { readFileSync } from "node:fs";
import { z } from "zod";

/** Pyth Lazer's production signer (Solana storage account 3rdJbq…, OP-PIP-45; D-056). */
const PYTH_LAZER_SIGNER = new PublicKey("9gKEEcFzSd1PDYBKWAKZi4Sq4ZCUaVX5oTr8kEjdwsfR");
const TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
const TRADING_DATE = 20_261_009;
const CLOSE_WINDOW_SECS = 30n;
const OVERRIDE_DELAY_SECS = 5n;

const env = z
  .object({
    ANCHOR_PROVIDER_URL: z.url(),
    ANCHOR_WALLET: z.string().min(1),
    E2E_PROGRAM_ID: z.string().min(32),
    PYTH_API_TOKEN: z.string().min(8),
    PYTH_LAZER_URL: z.url().default(PYTH_LAZER_URL),
  })
  .parse(process.env);
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(env.ANCHOR_PROVIDER_URL)) {
  throw new Error("pyth-settle runs against a local validator only");
}

const connection = new Connection(env.ANCHOR_PROVIDER_URL, "confirmed");
const admin = Keypair.fromSecretKey(
  Uint8Array.from(z.array(z.number()).parse(JSON.parse(readFileSync(env.ANCHOR_WALLET, "utf8")))),
);
const programId = new PublicKey(env.E2E_PROGRAM_ID);
const program: Program<Meridian> = createMeridianProgram(
  new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" }),
  programId,
);
const config = findConfigPda(programId).address;
const evidence: Record<string, unknown> = {};

const say = (line: string): void => console.log(`[pyth-e2e] ${line}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const feedIds = (): number[] => TICKERS.map((t) => PYTH_FEED_IDS[t] ?? 0);
const errorCode = (name: string): number => {
  const found = program.idl.errors.find((e) => e.name === name);
  if (found === undefined) {
    throw new Error(`no error ${name} in the IDL`);
  }
  return found.code;
};

async function chainTime(): Promise<number> {
  const time = await connection.getBlockTime(await connection.getSlot("confirmed"));
  if (time === null) {
    throw new Error("no block time");
  }
  return time;
}

async function waitForChainTime(target: number): Promise<void> {
  while ((await chainTime()) < target) {
    await sleep(1_000);
  }
}

let usdcMint = PublicKey.default;
const pythOn = (overrides: Partial<PythConfigInput> = {}): PythConfigInput => ({
  lazerSigner: PYTH_LAZER_SIGNER,
  feedIds: feedIds(),
  maxAgeSecs: CLOSE_WINDOW_SECS,
  ...overrides,
});

async function updateConfig(pyth: PythConfigInput, maxConfBps = 5): Promise<string> {
  return program.methods
    .updateConfig(
      configParamsArg({
        automationAuthority: admin.publicKey,
        maxStalenessSlots: 30n,
        maxConfBps,
        overrideDelaySecs: OVERRIDE_DELAY_SECS,
        tickers: [],
        pyth,
      }),
    )
    .accountsStrict({ config, admin: admin.publicKey, usdcMint })
    .rpc({ commitment: "confirmed" });
}

async function initConfig(): Promise<void> {
  usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
  const tickers: TickerInput[] = TICKERS.map((symbol) => {
    const feeds: [PublicKey, PublicKey] = [
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    ];
    return { symbol, feeds, feedHashes: [feeds[0].toBytes(), feeds[1].toBytes()] };
  });
  const [first, ...rest] = configParamsBatches(
    {
      automationAuthority: admin.publicKey,
      maxStalenessSlots: 30n,
      maxConfBps: 5,
      overrideDelaySecs: OVERRIDE_DELAY_SECS,
      pyth: PYTH_DISABLED,
    },
    tickers,
  );
  if (first === undefined) {
    throw new Error("no config batch");
  }
  await program.methods
    .initializeConfig(configParamsArg(first))
    .accountsStrict({
      config,
      admin: admin.publicKey,
      usdcMint,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  for (const batch of rest) {
    await program.methods
      .updateConfig(configParamsArg(batch))
      .accountsStrict({ config, admin: admin.publicKey, usdcMint })
      .rpc({ commitment: "confirmed" });
  }
  evidence.updateConfigSignature = await updateConfig(pythOn());
  const pinned = await readPythConfig(program, config);
  say(
    `update_config: signer ${pinned.signer.toBase58()}, feeds ${JSON.stringify(pinned.feedIds)}, window ${pinned.closeWindowSecs}s`,
  );
}

async function fetchAt(timestampSecs: number): Promise<SignedPythUpdate> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchSignedPrice({
        post: (url, init) => fetch(url, { method: "POST", ...init }),
        token: env.PYTH_API_TOKEN,
        baseUrl: env.PYTH_LAZER_URL,
        feedId: PYTH_FEED_IDS.AAPL ?? 0,
        timestampUs: BigInt(timestampSecs) * 1_000_000n,
      });
    } catch (error) {
      // The newest updates can take a moment to be queryable by timestamp.
      if (attempt >= 20 || !String(error).includes("HTTP 404")) {
        throw error;
      }
      await sleep(1_500);
    }
  }
}

async function createMarket(strikeCents: bigint, closeTs: number): Promise<OpenMarket> {
  const ops = await chainMarketOps(
    program,
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    SystemProgram.programId,
  );
  const key = { symbol: "AAPL", tradingDate: TRADING_DATE, strikeCents };
  await ops.create({ key, closeTs });
  return {
    address: marketAddresses(key, programId).market,
    ticker: "AAPL",
    tradingDate: TRADING_DATE,
    closeTs,
    strikeCents,
  };
}

/** Sends `[ed25519(update), settle_market(market)]` and expects `errorName`. */
async function expectRejected(
  update: SignedPythUpdate,
  market: OpenMarket,
  errorName: string,
): Promise<void> {
  const feeds: [PublicKey, PublicKey] = [PublicKey.default, PublicKey.default];
  const [settle] = await buildPythSettleInstructions({
    program,
    config,
    payer: admin.publicKey,
    markets: [market.address],
    feeds,
  });
  const ixs: TransactionInstruction[] = [
    pythEd25519Ix(update),
    ...(settle === undefined ? [] : [settle]),
  ];
  try {
    await program.provider.sendAndConfirm?.(new Transaction().add(...ixs), [], {
      commitment: "confirmed",
    });
  } catch (error) {
    const text = `${String(error)} ${JSON.stringify((error as { logs?: unknown }).logs ?? [])}`;
    const code = errorCode(errorName);
    if (text.includes(`Error Number: ${code}`) || text.includes(`0x${code.toString(16)}`)) {
      say(`rejected as expected: ${errorName} (${code})`);
      (evidence.rejections as string[]).push(errorName);
      return;
    }
    throw new Error(`expected ${errorName}, got: ${text.slice(0, 600)}`);
  }
  throw new Error(`expected ${errorName}, but the settle succeeded`);
}

async function main(): Promise<void> {
  evidence.rejections = [];
  await initConfig();

  const probe = await fetchAt((await chainTime()) - 30);
  const dollars = Number(probe.parsed.price) * 10 ** probe.parsed.exponent;
  const below = BigInt(Math.floor(dollars / 10) * 10 * 100);
  const above = below + 1_000n;
  say(`AAPL now ≈ $${dollars.toFixed(2)}: strikes ${below / 100n} and ${above / 100n}`);

  const T = (await chainTime()) + 15;
  const yes = await createMarket(below, T);
  const no = await createMarket(above, T);
  const late = await createMarket(below - 1_000n, T + 8);
  say(`markets created, close T=${T} (and T+8 for the third)`);

  await waitForChainTime(T + 1);
  const update = await fetchAt(T);
  const p = update.parsed;
  evidence.update = {
    timestampUs: p.timestampUs.toString(),
    feedId: p.feedId,
    price: p.price.toString(),
    exponent: p.exponent,
    confidence: p.confidence?.toString() ?? null,
    confidenceBps: confidenceBps(p),
    signer: new PublicKey(update.publicKey).toBase58(),
  };
  say(`Pyth update at T: ${JSON.stringify(evidence.update)}`);
  if (!new PublicKey(update.publicKey).equals(PYTH_LAZER_SIGNER)) {
    throw new Error("the live update is not signed by the expected Pyth Lazer signer");
  }

  // ---- 4. rejections with the real signed bytes -------------------------------------------------
  await updateConfig(pythOn({ lazerSigner: Keypair.generate().publicKey }));
  await expectRejected(update, yes, "PythWrongSigner");
  const wrongFeeds = feedIds();
  wrongFeeds[0] = PYTH_FEED_IDS.AMZN ?? 0;
  await updateConfig(pythOn({ feedIds: wrongFeeds }));
  await expectRejected(update, yes, "OracleFeedHashMismatch");
  await updateConfig(pythOn());
  await waitForChainTime(late.closeTs + 1);
  await expectRejected(update, late, "OracleBeforeClose");
  const confBps = confidenceBps(p);
  if (confBps > 1) {
    await updateConfig(pythOn(), 1);
    await expectRejected(update, yes, "PythConfidenceTooWide");
    await updateConfig(pythOn());
  } else {
    say(
      `live confidence ${confBps.toFixed(3)} bps ≤ 1 bps (the minimum max_conf_bps): too-wide case covered in LiteSVM only`,
    );
  }
  const afterWindow = late.closeTs + Number(CLOSE_WINDOW_SECS) + 1;
  await waitForChainTime(afterWindow + 1);
  await expectRejected(await fetchAt(afterWindow), late, "PythAfterCloseWindow");

  // ---- 5. the automation Pyth settler ------------------------------------------------------------
  const settler = createPythSettler({
    readConfig: () => readPythConfig(program, config),
    fetchSigned: (_feedId, timestampUs) => fetchAt(Number(timestampUs / 1_000_000n)),
    buildSettleIxs: (markets, feeds) =>
      buildPythSettleInstructions({
        program,
        config,
        payer: admin.publicKey,
        markets: markets.map((m) => m.address),
        feeds,
      }),
    payer: admin.publicKey,
    executor: connectionExecutor(connection, admin),
    now: () => new Date(),
  });
  const reports = await settler.settle([yes, no], [PublicKey.default, PublicKey.default]);
  evidence.settleSignatures = reports.flatMap((r) => r.signatures);
  const scaled = p.price * 10n ** BigInt(18 + p.exponent);
  for (const [market, want] of [
    [yes, "yes"],
    [no, "no"],
  ] as const) {
    const account = await program.account.market.fetch(market.address);
    const outcome = Object.keys(account.outcome)[0];
    const price = BigInt(account.settlePriceScaled.toString());
    if (
      !("settled" in account.status) ||
      outcome !== want ||
      price !== scaled ||
      !("oracle" in account.settleSource)
    ) {
      throw new Error(
        `market ${market.strikeCents} not settled as ${want} from Pyth: ${JSON.stringify(account)}`,
      );
    }
    say(`settled strike $${market.strikeCents / 100n}: ${want}, price_scaled ${price}`);
  }

  // ---- 6. admin override as the fallback ---------------------------------------------------------
  await waitForChainTime(late.closeTs + Number(OVERRIDE_DELAY_SECS) + 1);
  evidence.overrideSignature = await program.methods
    .adminSettleOverride(new BN((dollars * 100).toFixed(0)))
    .accountsStrict({ config, market: late.address, admin: admin.publicKey })
    .rpc({ commitment: "confirmed" });
  const overridden = await program.account.market.fetch(late.address);
  if (!("override" in overridden.settleSource)) {
    throw new Error("override did not settle the market");
  }
  say("admin_settle_override settled the market Pyth could not");
  console.log(`PYTH_E2E_EVIDENCE=${JSON.stringify(evidence)}`);
  say("PASS");
}

main().catch((error: unknown) => {
  console.error(`[pyth-e2e] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
