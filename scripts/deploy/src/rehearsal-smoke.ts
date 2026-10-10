// M3-10b upgrade rehearsal smoke (local validator ONLY; refuses any non-loopback RPC). Driven by
// scripts/rehearse-config-migration.sh; each phase is one subcommand:
//   check-old       old (devnet) program against the cloned v1 Config: pause + unpause succeed
//   pre-migration   new program, Config not migrated yet: pause fails cleanly with Anchor 3003
//                   (AccountDidNotDeserialize) and the account is untouched
//   post-migration  update_config, create_strike_market, mint_pair, place_order (rest + fill),
//                   settle_market via the Pyth path (Ed25519 precompile), settle_funds, redeem
// Env: SOLANA_RPC_URL (loopback), ADMIN_KEYPAIR_PATH, PYTH_SIGNER_KEYPAIR_PATH (post-migration),
// MERIDIAN_PROGRAM_ID (optional).
import {
  assertCluster,
  BN,
  buildTrade,
  configParamsArg,
  findConfigPda,
  findOpenOrdersPda,
  marketAddresses,
  MERIDIAN_PROGRAM_ID,
  pythConfigFromAccount,
  symbolBytes,
} from "@meridian/client";
import { createAccount, createMint, getAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";

import { createProgram } from "./lib/chain-io";
import { readKeypairFile } from "./lib/keypair";
import { CONFIG_V1_LEN } from "./lib/migrate-config";

const say = (line: string): void => {
  process.stdout.write(`smoke: ${line}\n`);
};

/** Pyth Lazer PayloadData magic (programs/meridian/src/pyth). */
const PAYLOAD_FORMAT_MAGIC = 2_479_346_549;
const META_SLOT = 5;
const STRIKE_CENTS = 68_000n;
/** A clearly synthetic trading date: no real market uses it. */
const TRADING_DATE = 20_991_231;
const CLOSE_IN_SECS = 20;
/** $681.25 with 8 fractional digits (exponent -8). */
const PYTH_PRICE = 68_125_000_000n;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

async function chainNow(connection: Connection): Promise<number> {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  if (clock === null) throw new Error("no Clock sysvar");
  return Number(clock.data.readBigInt64LE(32));
}

function pythPayload(feedId: number, timestampUs: bigint): Buffer {
  const out = Buffer.alloc(4 + 8 + 1 + 1 + 4 + 1 + 1 + 1 + 8 + 1 + 2);
  let o = 0;
  o = out.writeUInt32LE(PAYLOAD_FORMAT_MAGIC, o);
  o = out.writeBigInt64LE(timestampUs, o);
  o = out.writeUInt8(1, o); // channel
  o = out.writeUInt8(1, o); // one feed
  o = out.writeUInt32LE(feedId, o);
  o = out.writeUInt8(2, o); // two properties
  o = out.writeUInt8(0, o); // Price
  o = out.writeUInt8(1, o); // Some
  o = out.writeBigInt64LE(PYTH_PRICE, o);
  o = out.writeUInt8(4, o); // Exponent
  out.writeInt16LE(-8, o);
  return out;
}

function errorText(error: unknown): string {
  const logs =
    typeof error === "object" && error !== null && "logs" in error && Array.isArray(error.logs)
      ? (error.logs as unknown[]).join("\n")
      : "";
  return `${error instanceof Error ? error.message : String(error)}\n${logs}`;
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  const rpcUrl = env("SOLANA_RPC_URL");
  const connection = new Connection(rpcUrl, "confirmed");
  await assertCluster({
    cluster: "localnet",
    rpcUrl,
    getGenesisHash: () => connection.getGenesisHash(),
  });
  const programId =
    process.env.MERIDIAN_PROGRAM_ID === undefined
      ? MERIDIAN_PROGRAM_ID
      : new PublicKey(process.env.MERIDIAN_PROGRAM_ID);
  const admin = readKeypairFile(env("ADMIN_KEYPAIR_PATH"));
  const program = createProgram(connection, admin, programId);
  const config = findConfigPda(programId).address;
  const configSize = async (): Promise<number> =>
    (await connection.getAccountInfo(config, "confirmed"))?.data.length ?? 0;

  if (phase === "check-old") {
    for (const name of ["pause", "unpause"] as const) {
      const sig = await program.methods[name]()
        .accountsStrict({ config, admin: admin.publicKey })
        .rpc({ commitment: "confirmed" });
      say(`old program: ${name} OK against the ${await configSize()}-byte Config (${sig})`);
    }
    return;
  }

  if (phase === "pre-migration") {
    const before = await connection.getAccountInfo(config, "confirmed");
    try {
      await program.methods.pause().accountsStrict({ config, admin: admin.publicKey }).rpc();
    } catch (error) {
      const text = errorText(error);
      if (!/AccountDidNotDeserialize|0xbbb|3003/.test(text) || /panicked/.test(text)) {
        throw new Error(`pause failed, but not with a clean decode error:\n${text}`);
      }
      const after = await connection.getAccountInfo(config, "confirmed");
      if (after === null || before === null || !after.data.equals(before.data)) {
        throw new Error("the Config changed during the failed pause");
      }
      say(
        `new program, unmigrated ${after.data.length}-byte Config: pause fails cleanly ` +
          "with AccountDidNotDeserialize (Anchor 3003, no panic); account unchanged",
      );
      return;
    }
    throw new Error("pause unexpectedly succeeded against the unmigrated Config");
  }

  if (phase !== "post-migration") {
    throw new Error("usage: rehearsal-smoke check-old | pre-migration | post-migration");
  }
  if ((await configSize()) <= CONFIG_V1_LEN) throw new Error("the Config is not migrated");
  const pythSigner = readKeypairFile(env("PYTH_SIGNER_KEYPAIR_PATH"));
  const before = await program.account.config.fetch(config);
  if (!before.pythLazerSigner.equals(pythSigner.publicKey)) {
    throw new Error("migrate-config did not pin the rehearsal Pyth signer");
  }

  // 1. update_config: local automation key and USDC mint; Pyth fields and tickers pass through.
  const automation = Keypair.generate();
  const usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
  await program.methods
    .updateConfig(
      configParamsArg({
        automationAuthority: automation.publicKey,
        maxStalenessSlots: BigInt(before.maxStalenessSlots.toString()),
        maxConfBps: before.maxConfBps,
        overrideDelaySecs: BigInt(before.overrideDelaySecs.toString()),
        tickers: [],
        pyth: pythConfigFromAccount(before),
      }),
    )
    .accountsStrict({ config, admin: admin.publicKey, usdcMint })
    .rpc({ commitment: "confirmed" });
  const updated = await program.account.config.fetch(config);
  if (
    JSON.stringify(updated.tickers) !== JSON.stringify(before.tickers) ||
    !updated.pythLazerSigner.equals(before.pythLazerSigner) ||
    JSON.stringify(updated.pythFeedIds) !== JSON.stringify(before.pythFeedIds) ||
    !updated.admin.equals(before.admin) ||
    !updated.automationAuthority.equals(automation.publicKey)
  ) {
    throw new Error("update_config changed more (or less) than it should");
  }
  say("update_config OK (automation + mint replaced; tickers, admin and Pyth fields kept)");

  // 2. Fund the actors.
  const fund = new Transaction();
  const maker = Keypair.generate();
  const taker = Keypair.generate();
  for (const who of [automation, maker, taker]) {
    fund.add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: who.publicKey,
        lamports: 1_000_000_000,
      }),
    );
  }
  await sendAndConfirmTransaction(connection, fund, [admin], { commitment: "confirmed" });

  // 3. create_strike_market (automation authority), closing in CLOSE_IN_SECS chain seconds.
  const closeTs = (await chainNow(connection)) + CLOSE_IN_SECS;
  const a = marketAddresses(
    { symbol: "META", tradingDate: TRADING_DATE, strikeCents: STRIKE_CENTS },
    programId,
  );
  const automationProgram = createProgram(connection, automation, programId);
  await automationProgram.methods
    .createStrikeMarket(
      Array.from(symbolBytes("META")),
      new BN(STRIKE_CENTS.toString()),
      TRADING_DATE,
      new BN(closeTs),
    )
    .accountsStrict({
      config,
      automationAuthority: automation.publicKey,
      market: a.market,
      yesMint: a.yesMint,
      noMint: a.noMint,
      vault: a.vault,
      escrowUsdc: a.escrowUsdc,
      escrowYes: a.escrowYes,
      book: a.book,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  say(`create_strike_market OK (META $680, close_ts=${closeTs})`);

  // 4. Token accounts, mint_pair, a resting ask and a filling bid.
  const accounts = async (who: Keypair) => {
    const usdc = await createAccount(
      connection,
      admin,
      usdcMint,
      who.publicKey,
      Keypair.generate(),
    );
    const yes = await createAccount(
      connection,
      admin,
      a.yesMint,
      who.publicKey,
      Keypair.generate(),
    );
    const no = await createAccount(connection, admin, a.noMint, who.publicKey, Keypair.generate());
    await mintTo(connection, admin, usdcMint, usdc, admin, 100_000_000n);
    return { usdc, yes, no };
  };
  const m = await accounts(maker);
  const t = await accounts(taker);
  await program.methods
    .mintPair(new BN(2))
    .accountsStrict({
      config,
      market: a.market,
      user: maker.publicKey,
      userUsdc: m.usdc,
      userYes: m.yes,
      userNo: m.no,
      yesMint: a.yesMint,
      noMint: a.noMint,
      vault: a.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([maker])
    .rpc({ commitment: "confirmed" });
  say("mint_pair OK (maker: 2 pairs)");
  const trade = async (
    who: Keypair,
    acc: typeof m,
    intent: "SELL_YES" | "BUY_YES",
    kind: "limit" | "ioc",
    makers: PublicKey[],
  ) => {
    const ix = await buildTrade({
      program,
      intent,
      kind,
      priceCents: 55,
      qty: 1n,
      accounts: {
        user: who.publicKey,
        userUsdc: acc.usdc,
        userYes: acc.yes,
        userNo: acc.no,
        market: a,
      },
      makers,
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [who], {
      commitment: "confirmed",
    });
  };
  await trade(maker, m, "SELL_YES", "limit", []);
  await trade(taker, t, "BUY_YES", "ioc", [maker.publicKey]);
  say("place_order OK (maker rests 1 YES @ 55c, taker fills it IOC)");

  // 5. Wait for close on the chain clock, then settle via Pyth.
  while ((await chainNow(connection)) < closeTs) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const feedId = updated.pythFeedIds[META_SLOT];
  if (feedId === undefined || feedId === 0) throw new Error("no META Pyth feed id pinned");
  const message = pythPayload(feedId, BigInt(await chainNow(connection)) * 1_000_000n);
  const verify = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: pythSigner.secretKey,
    message,
  });
  const settle = await program.methods
    .settleMarket(0)
    .accountsStrict({
      config,
      market: a.market,
      feedTiingo: PublicKey.default,
      feedTwelveData: PublicKey.default,
      redstonePrice: null,
      oracleConfig: null,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      payer: admin.publicKey,
    })
    .instruction();
  const settleSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(verify, settle),
    [admin],
    { commitment: "confirmed" },
  );
  const market = await program.account.market.fetch(a.market);
  const expectedScaled = (PYTH_PRICE * 10n ** 10n).toString();
  if (!("yes" in market.outcome) || market.settlePriceScaled.toString() !== expectedScaled) {
    throw new Error(`unexpected settlement: ${JSON.stringify(market.outcome)}`);
  }
  say(`settle_market via Pyth OK: YES at $681.25 (${settleSig})`);

  // 6. settle_funds for both, then the taker redeems its winning YES for $1.00.
  for (const [who, acc] of [
    [maker, m],
    [taker, t],
  ] as const) {
    await program.methods
      .settleFunds()
      .accountsStrict({
        market: a.market,
        owner: who.publicKey,
        openOrders: findOpenOrdersPda(a.market, who.publicKey, programId).address,
        escrowUsdc: a.escrowUsdc,
        escrowYes: a.escrowYes,
        userUsdc: acc.usdc,
        userYes: acc.yes,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who])
      .rpc({ commitment: "confirmed" });
  }
  const usdcBefore = (await getAccount(connection, t.usdc)).amount;
  await program.methods
    .redeem(new BN(1), new BN(0))
    .accountsStrict({
      market: a.market,
      user: taker.publicKey,
      userUsdc: t.usdc,
      userYes: t.yes,
      userNo: t.no,
      yesMint: a.yesMint,
      noMint: a.noMint,
      vault: a.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([taker])
    .rpc({ commitment: "confirmed" });
  const paid = (await getAccount(connection, t.usdc)).amount - usdcBefore;
  if (paid !== 1_000_000n) throw new Error(`winner redeem paid ${paid}, expected 1000000`);
  say("settle_funds + winner redeem OK (taker paid $1.00 for 1 YES)");
  say("POST-MIGRATION SMOKE PASSED");
}

main().catch((error: unknown) => {
  process.stderr.write(`smoke: FAILED: ${errorText(error)}\n`);
  process.exitCode = 1;
});
