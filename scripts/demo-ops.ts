#!/usr/bin/env node
/**
 * M3-07: Local fault-injection demo of the ops-agent override path.
 *
 * The staged scenario: one oracle source reports a close 2% off (FAULT_INJECT_SOURCE, local
 * only), settlement fails the confidence check, the automation service posts an incident to
 * ops-agent, the agent investigates (with recorded fixtures; live Claude call optional behind
 * ENABLE_LIVE_LLM=1), the admin approves the draft, and the market settles after the shortened
 * override delay.
 *
 * Requirements: local validator running, M3-05 (ops-agent) and M3-06 (admin override) deployed.
 * AC1: runs end to end on a fresh local validator; prints each stage and the final settle tx.
 * AC2: FAULT_INJECT_SOURCE refused on any non-local cluster.
 * AC3: default run makes no live API calls (fixtures + deterministic fallback).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AnchorProvider, BN, type Program, Wallet } from "@coral-xyz/anchor";
import { DateTime } from "luxon";
import {
  type Meridian,
  configParamsArg,
  createMeridianProgram,
  findConfigPda,
  marketAddresses,
  symbolBytes,
  tradingDate,
  assertCluster,
  STRIKE_CENTS_TO_SCALED,
} from "@meridian/client";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { z } from "zod";

import {
  validateFaultInjection,
  applyFaultOffset,
  FAULT_INJECT_BPS,
} from "./lib/demo/fault-inject";

interface DemoEnv {
  readonly SOLANA_CLUSTER: string;
  readonly SOLANA_RPC_URL: string;
  readonly MERIDIAN_PROGRAM_ID: string;
  readonly USDC_MINT: string;
  readonly ADMIN_KEYPAIR_PATH: string;
  readonly SERVICE_TOKEN: string;
  readonly OPS_AGENT_URL: string;
  readonly FAULT_INJECT_SOURCE: string | undefined;
  readonly ENABLE_LIVE_LLM: string | undefined;
}

function parseEnv(): DemoEnv {
  const env = process.env;
  if (env.SOLANA_CLUSTER !== "localnet") {
    throw new Error("SOLANA_CLUSTER must be 'localnet' for demo-ops");
  }
  if (!env.SOLANA_RPC_URL || !env.MERIDIAN_PROGRAM_ID || !env.USDC_MINT) {
    throw new Error("Missing required environment variables");
  }
  if (!env.ADMIN_KEYPAIR_PATH || !env.SERVICE_TOKEN || !env.OPS_AGENT_URL) {
    throw new Error("Missing required service configuration");
  }
  return {
    SOLANA_CLUSTER: env.SOLANA_CLUSTER,
    SOLANA_RPC_URL: env.SOLANA_RPC_URL,
    MERIDIAN_PROGRAM_ID: env.MERIDIAN_PROGRAM_ID,
    USDC_MINT: env.USDC_MINT,
    ADMIN_KEYPAIR_PATH: env.ADMIN_KEYPAIR_PATH,
    SERVICE_TOKEN: env.SERVICE_TOKEN,
    OPS_AGENT_URL: env.OPS_AGENT_URL,
    FAULT_INJECT_SOURCE: env.FAULT_INJECT_SOURCE,
    ENABLE_LIVE_LLM: env.ENABLE_LIVE_LLM,
  };
}

interface DemoContext {
  readonly connection: Connection;
  readonly program: Program<Meridian>;
  readonly admin: Keypair;
  readonly config: PublicKey;
  readonly env: DemoEnv;
  readonly faultConfig: ReturnType<typeof validateFaultInjection>;
}

interface MarketKey {
  symbol: string;
  tradingDate: number;
  strikeCents: bigint;
  closeTs: number;
}

async function main(): Promise<void> {
  console.log("=== M3-07: Demo ops-agent override path ===\n");

  const env = parseEnv();
  const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");

  // AC2: validate fault injection is only on localnet (uses assertCluster to check genesis)
  const faultConfig = validateFaultInjection();
  if (faultConfig.source !== undefined) {
    // Only check cluster if fault injection is requested
    await assertCluster({
      cluster: "localnet",
      rpcUrl: env.SOLANA_RPC_URL,
      getGenesisHash: () => connection.getGenesisHash(),
    });
  }

  console.log(`Stage 1: Fault injection validated`);
  console.log(`  Source to fault: ${faultConfig.source ?? "none"}`);
  console.log(`  Offset: ${faultConfig.offsetBps} bps`);
  if (!faultConfig.source) {
    throw new Error("FAULT_INJECT_SOURCE must be set for this demo");
  }

  console.log(`  Cluster: ${env.SOLANA_CLUSTER}`);
  console.log(`  Ops agent: ${env.OPS_AGENT_URL}`);
  console.log(`  Live LLM: ${env.ENABLE_LIVE_LLM === "1" ? "enabled" : "disabled (AC3)"}\n`);

  const adminSecretKey = Uint8Array.from(
    z.array(z.number()).parse(JSON.parse(readFileSync(resolve(env.ADMIN_KEYPAIR_PATH), "utf8"))),
  );
  const admin = Keypair.fromSecretKey(adminSecretKey);
  const programId = new PublicKey(env.MERIDIAN_PROGRAM_ID);

  const provider = new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" });
  const program = createMeridianProgram(provider, programId);
  const config = findConfigPda(programId).address;

  const ctx: DemoContext = {
    connection,
    program,
    admin,
    config,
    env,
    faultConfig,
  };

  // AC3: Start demo ops-agent with FixtureTools if ENABLE_LIVE_LLM is not set
  let demoOpsAgent: ChildProcess | undefined;
  if (env.ENABLE_LIVE_LLM !== "1") {
    console.log("\nStarting demo ops-agent with FixtureTools (AC3: no live API calls)...");
    const port = new URL(env.OPS_AGENT_URL).port;
    const fixturePath = resolve(import.meta.dirname, "lib/demo/fixtures.json");
    const storePath = "/tmp/ops-agent-demo-store.json";
    demoOpsAgent = spawn(
      "uv",
      [
        "run",
        "python",
        resolve(import.meta.dirname, "lib/demo/ops-agent-demo.py"),
        port,
        env.SERVICE_TOKEN,
        storePath,
        fixturePath,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    // Give the server time to start
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log(`  Demo ops-agent started on port ${port} (FixtureTools, no LLM)\n`);
  }

  try {
    // Stage 2: Ensure config exists
    await ensureDeployed(ctx);

    // Stage 3: Pin META local feeds in config
    console.log("\nStage 3: Pinning META local feeds in config");
    await pinLocalFeeds(ctx, "META");

    // Stage 4: Create a market that will close in 3 minutes
    console.log("\nStage 4: Creating test market");
    const marketKey = await createTestMarket(ctx);
    console.log(
      `  Market key: ${marketKey.symbol} ${marketKey.tradingDate} $${Number(marketKey.strikeCents) / 100}`,
    );
    console.log(`  Close: ${new Date(marketKey.closeTs * 1000).toISOString()}`);
    console.log(`  Waiting for market close...`);

    // Stage 4: Wait for close
    await waitForClose(ctx, marketKey);

    // Stage 5: Set oracle values with fault
    console.log("\nStage 5: Setting oracle values with fault injection");
    await setFaultedOracle(ctx, marketKey);

    // Stage 6: Attempt settlement (will fail spread check)
    console.log("\nStage 6: Attempting settlement (will fail spread check)");
    const incident = await attemptSettlement(ctx, marketKey);
    console.log(`  Settlement failed as expected`);
    console.log(`  Incident posted: ${incident.incidentId}`);

    // Stage 7: Get draft from ops-agent
    console.log("\nStage 7: Fetching override draft from ops-agent");
    const draft = await getDraft(ctx, incident.incidentId);
    console.log(`  Draft received: ${draft.proposedPriceCents}¢`);
    console.log(`  Note: ${draft.note.slice(0, 100)}...`);

    // Stage 8: Set short override delay for the demo
    console.log("\nStage 8: Setting short override delay");
    await setShortOverrideDelay(ctx);

    // Stage 9: Wait for override delay
    console.log("\nStage 9: Waiting for override delay");
    await waitForOverrideDelay(ctx, marketKey);

    // Stage 10: Settle with admin override
    console.log("\nStage 10: Settling with admin override");
    const settleTx = await settleWithOverride(ctx, marketKey, draft.proposedPriceCents);
    console.log(`  Market settled successfully!`);
    console.log(`  Settle tx: ${settleTx}\n`);

    console.log("=== Demo completed successfully ===");
  } finally {
    // Cleanup: stop demo ops-agent if it was started
    if (demoOpsAgent) {
      console.log("\nStopping demo ops-agent...");
      demoOpsAgent.kill();
    }
  }
}

async function ensureDeployed(ctx: DemoContext): Promise<void> {
  console.log("\nStage 2: Ensuring deployment");
  try {
    const configAccount = await ctx.program.account.config.fetch(ctx.config);
    console.log(`  Config exists: ${ctx.config.toString()}`);
    console.log(`  Admin: ${configAccount.admin.toString()}`);
  } catch {
    console.log(`  Config not found - deploy with scripts/deploy first`);
    throw new Error("Config account does not exist. Run deployment first.");
  }
}

async function pinLocalFeeds(ctx: DemoContext, symbol: string): Promise<void> {
  const configAccount = await ctx.program.account.config.fetch(ctx.config);

  // Derive local feed PDAs for this symbol (AC1: settle_market requires config-pinned feeds)
  const feeds: [PublicKey, PublicKey] = [
    PublicKey.findProgramAddressSync(
      [Buffer.from("local_feed"), symbolBytes(symbol), Buffer.from([0])],
      ctx.program.programId,
    )[0],
    PublicKey.findProgramAddressSync(
      [Buffer.from("local_feed"), symbolBytes(symbol), Buffer.from([1])],
      ctx.program.programId,
    )[0],
  ];

  // Local feed hash is the PDA address itself (oracle::local_reading)
  const feedHashes: [Uint8Array, Uint8Array] = [feeds[0].toBytes(), feeds[1].toBytes()];

  await ctx.program.methods
    .updateConfig(
      configParamsArg({
        automationAuthority: configAccount.automationAuthority,
        maxStalenessSlots: BigInt(configAccount.maxStalenessSlots.toString()),
        maxConfBps: configAccount.maxConfBps,
        overrideDelaySecs: BigInt(configAccount.overrideDelaySecs.toString()),
        tickers: [{ index: 0, ticker: { symbol, feeds, feedHashes } }],
      }),
    )
    .accountsStrict({
      config: ctx.config,
      admin: ctx.admin.publicKey,
      usdcMint: configAccount.usdcMint,
    })
    .signers([ctx.admin])
    .rpc();

  console.log(`  Pinned ${symbol} local feeds in config slot 0`);
  console.log(`    Feed 0: ${feeds[0].toString()}`);
  console.log(`    Feed 1: ${feeds[1].toString()}`);
}

async function createTestMarket(ctx: DemoContext): Promise<MarketKey> {
  const symbol = "META";
  const strikeCents = 68000n;
  const nowET = DateTime.now().setZone("America/New_York");
  const date = tradingDate(nowET.year, nowET.month, nowET.day);

  const addresses = marketAddresses(
    { symbol, tradingDate: date, strikeCents },
    ctx.program.programId,
  );

  // Check if market exists; if not, create it (admin is automation authority in demo)
  try {
    const marketData = await ctx.program.account.market.fetch(addresses.market);
    console.log(`  Market exists at ${addresses.market.toString()}`);
    console.log(`  Using existing closeTs: ${marketData.closeTs.toString()}`);
    return {
      symbol,
      tradingDate: date,
      strikeCents,
      closeTs: marketData.closeTs.toNumber(),
    };
  } catch {
    // Market doesn't exist - create it with a 3-minute close for the demo
    console.log(`  Market doesn't exist, creating at ${addresses.market.toString()}...`);
    const blockTime = await ctx.connection.getBlockTime(await ctx.connection.getSlot("confirmed"));
    const now = blockTime ?? Math.floor(Date.now() / 1000);
    const closeTs = now + 180; // 3 minutes from now

    const configAccount = await ctx.program.account.config.fetch(ctx.config);

    await ctx.program.methods
      .createStrikeMarket(
        Array.from(symbolBytes(symbol)),
        new BN(String(strikeCents)),
        date,
        new BN(closeTs),
      )
      .accountsStrict({
        config: ctx.config,
        automationAuthority: ctx.admin.publicKey,
        market: addresses.market,
        yesMint: addresses.yesMint,
        noMint: addresses.noMint,
        vault: addresses.vault,
        escrowUsdc: addresses.escrowUsdc,
        escrowYes: addresses.escrowYes,
        book: addresses.book,
        usdcMint: configAccount.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([ctx.admin])
      .rpc();

    console.log(`  Market created! Close in 3 minutes (closeTs: ${closeTs})`);
    return {
      symbol,
      tradingDate: date,
      strikeCents,
      closeTs,
    };
  }
}

async function waitForClose(ctx: DemoContext, marketKey: MarketKey): Promise<void> {
  const blockTime = await ctx.connection.getBlockTime(await ctx.connection.getSlot("confirmed"));
  const now = blockTime ?? Math.floor(Date.now() / 1000);
  const waitSecs = Math.max(0, marketKey.closeTs - now);
  console.log(
    `  Waiting ${waitSecs}s until close (cluster time: ${now}, close: ${marketKey.closeTs})...`,
  );
  await new Promise((resolve) => setTimeout(resolve, waitSecs * 1000 + 1000)); // Wait until after close
}

async function setFaultedOracle(ctx: DemoContext, marketKey: MarketKey): Promise<void> {
  const faultSource = ctx.faultConfig.source;
  if (!faultSource) {
    throw new Error("Fault source must be set");
  }

  const normalPrice = 70000; // $700.00 in cents
  const faultedPrice = Number(applyFaultOffset(BigInt(normalPrice), ctx.faultConfig.offsetBps));

  console.log(`  Normal price: $${normalPrice / 100}`);
  console.log(`  Faulted ${faultSource} price: $${faultedPrice / 100}`);
  console.log(`  Spread: ${ctx.faultConfig.offsetBps} bps (>> 5 bps threshold)`);

  // Call local_oracle_set for each source slot
  // tiingo = slot 0, twelvedata = slot 1
  const sourceSlots = { tiingo: 0, twelvedata: 1 };
  const faultedSlot = sourceSlots[faultSource];
  const normalSlot = faultedSlot === 0 ? 1 : 0;

  for (const [sourceIndex, priceCents] of [
    [normalSlot, normalPrice],
    [faultedSlot, faultedPrice],
  ]) {
    const sourceSlotNum = typeof sourceIndex === "number" ? sourceIndex : 0;

    // Derive local_feed PDA: ["local_feed", symbol, [source_slot]]
    const [feedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("local_feed"), symbolBytes(marketKey.symbol), Buffer.from([sourceSlotNum])],
      ctx.program.programId,
    );

    // Scale price: cents * 10^16 (as in tests/e2e/src/lifecycle.ts)
    const scaledValue = new BN((BigInt(priceCents) * STRIKE_CENTS_TO_SCALED).toString());
    const currentSlot = new BN(await ctx.connection.getSlot("confirmed"));

    await ctx.program.methods
      .localOracleSet(
        Array.from(symbolBytes(marketKey.symbol)),
        sourceSlotNum,
        scaledValue,
        currentSlot,
      )
      .accountsStrict({
        config: ctx.config,
        admin: ctx.admin.publicKey,
        localFeed: feedPda,
        systemProgram: PublicKey.default, // Not used but required by Anchor
      })
      .signers([ctx.admin])
      .rpc();

    console.log(
      `  Set source ${sourceSlotNum}: ${priceCents}¢ (scaled: ${scaledValue.toString()})`,
    );
  }
}

async function attemptSettlement(
  ctx: DemoContext,
  marketKey: MarketKey,
): Promise<{ incidentId: string }> {
  const addresses = marketAddresses(
    {
      symbol: marketKey.symbol,
      tradingDate: marketKey.tradingDate,
      strikeCents: marketKey.strikeCents,
    },
    ctx.program.programId,
  );

  // Try to settle with settle_market - should fail spread check due to 2% fault
  console.log(`  Attempting settle_market (will fail spread check)...`);
  try {
    // Derive oracle PDAs for both sources
    const oraclePdas = [0, 1].map(
      (slotIndex) =>
        PublicKey.findProgramAddressSync(
          [Buffer.from("local_feed"), symbolBytes(marketKey.symbol), Buffer.from([slotIndex])],
          ctx.program.programId,
        )[0],
    );

    await ctx.program.methods
      .settleMarket()
      .accountsStrict({
        config: ctx.config,
        market: addresses.market,
        feedTiingo: oraclePdas[0],
        feedTwelveData: oraclePdas[1],
        payer: ctx.admin.publicKey,
      })
      .rpc();

    // If we get here, settlement succeeded (shouldn't happen with 2% fault)
    throw new Error("Settlement succeeded unexpectedly - spread check should have failed");
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // Only continue if this is the expected OracleSpreadTooWide error (code 6031)
    // If accountsStrict or RPC fails, re-throw to fail the demo
    if (!errorMsg.includes("Oracle values differ by more than max_conf_bps")) {
      throw error;
    }
    console.log(`  Settlement failed with spread check: ${errorMsg}`);
  }

  // POST /incidents to ops-agent (with timeout per AC3)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${ctx.env.OPS_AGENT_URL}/incidents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.env.SERVICE_TOKEN}`,
      },
      body: JSON.stringify({
        trading_date: new Date(marketKey.closeTs * 1000).toISOString().split("T")[0],
        ticker: marketKey.symbol,
        markets: [marketKey.symbol],
        failure: `Spread check failed: ${FAULT_INJECT_BPS} bps >> 5 bps threshold`,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to post incident: ${response.status} ${await response.text()}`);
    }

    const result = z.object({ incident_id: z.string() }).parse(await response.json());
    return { incidentId: result.incident_id };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Draft schema matching M3-05 DraftView (architecture.md)
const sourceSchema = z.object({
  name: z.string(),
  close: z.number().int().nonnegative(),
  as_of: z.string(),
});

const draftSchema = z.object({
  incident_id: z.string(),
  market: z.string(),
  proposed_price_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sources: z.array(sourceSchema),
  spread_bps: z.number().int().nonnegative(),
  note: z.string(),
  status: z.string(),
});

async function getDraft(
  ctx: DemoContext,
  incidentId: string,
): Promise<{ proposedPriceCents: number; note: string }> {
  // AC3: ops-agent uses deterministic fallback unless OPS_AGENT_LLM=anthropic is set
  // ENABLE_LIVE_LLM controls whether the ops-agent service was started with that var
  if (ctx.env.ENABLE_LIVE_LLM !== "1") {
    console.log(`  Using deterministic fallback (AC3: no live API calls)`);
    console.log(`  (ops-agent started without OPS_AGENT_LLM=anthropic)`);
  }

  // GET /drafts with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${ctx.env.OPS_AGENT_URL}/drafts`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ctx.env.SERVICE_TOKEN}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch drafts: ${response.status} ${await response.text()}`);
    }

    const drafts = z.array(draftSchema).parse(await response.json());

    // Find the draft for our incident (not ignored)
    const draft = drafts.find((d) => d.incident_id === incidentId);
    if (!draft) {
      throw new Error(`No draft found for incident ${incidentId}`);
    }

    return {
      proposedPriceCents: draft.proposed_price_cents,
      note: draft.note,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function setShortOverrideDelay(ctx: DemoContext): Promise<void> {
  const configAccount = await ctx.program.account.config.fetch(ctx.config);
  const shortDelaySecs = 60n;

  await ctx.program.methods
    .updateConfig(
      configParamsArg({
        automationAuthority: configAccount.automationAuthority,
        maxStalenessSlots: BigInt(configAccount.maxStalenessSlots.toString()),
        maxConfBps: configAccount.maxConfBps,
        overrideDelaySecs: shortDelaySecs,
        tickers: [], // Empty array preserves existing ticker slots
      }),
    )
    .accountsStrict({
      config: ctx.config,
      admin: ctx.admin.publicKey,
      usdcMint: configAccount.usdcMint,
    })
    .signers([ctx.admin])
    .rpc();

  console.log(`  Updated override_delay_secs to ${shortDelaySecs}s (demo value)`);
}

async function waitForOverrideDelay(ctx: DemoContext, marketKey: MarketKey): Promise<void> {
  const overrideDelaySecs = 60; // Matches the on-chain value set by setShortOverrideDelay
  const enableAt = marketKey.closeTs + overrideDelaySecs;
  const blockTime = await ctx.connection.getBlockTime(await ctx.connection.getSlot("confirmed"));
  const now = blockTime ?? Math.floor(Date.now() / 1000);
  const waitSecs = Math.max(0, enableAt - now);

  console.log(`  Override enabled at: ${new Date(enableAt * 1000).toISOString()}`);
  console.log(`  Cluster time: ${now}, enableAt: ${enableAt}`);
  console.log(`  Waiting ${waitSecs}s...`);

  await new Promise((resolve) => setTimeout(resolve, waitSecs * 1000 + 1000));
}

async function settleWithOverride(
  ctx: DemoContext,
  marketKey: MarketKey,
  priceCents: number,
): Promise<string> {
  const addresses = marketAddresses(
    {
      symbol: marketKey.symbol,
      tradingDate: marketKey.tradingDate,
      strikeCents: marketKey.strikeCents,
    },
    ctx.program.programId,
  );

  const tx = await ctx.program.methods
    .adminSettleOverride(new BN(String(priceCents)))
    .accountsStrict({
      config: ctx.config,
      admin: ctx.admin.publicKey,
      market: addresses.market,
    })
    .signers([ctx.admin])
    .rpc();

  return tx;
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
