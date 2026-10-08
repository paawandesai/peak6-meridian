// Helpers for the abuse-case tests that need the program on a real (local) validator. They run
// only inside `make e2e` (scripts/e2e.sh exports the cluster, wallet and program ID after the
// lifecycle has initialised the config with local feeds); `make test-security` has no validator
// and skips them with an explicit reason, while the job-level halves of the same tests always run.
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";

import { AnchorProvider, type Program, Wallet } from "@coral-xyz/anchor";
import {
  BN,
  createMeridianProgram,
  findConfigPda,
  type Meridian,
  symbolBytes,
} from "@meridian/client";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

export interface Validator {
  readonly connection: Connection;
  readonly admin: Keypair;
  readonly programId: PublicKey;
  readonly program: Program<Meridian>;
  readonly config: PublicKey;
}

/** The validator session, or null when the suite is not running inside `make e2e`. */
export function validatorSession(): Validator | null {
  const rpc = process.env.ANCHOR_PROVIDER_URL;
  const wallet = process.env.ANCHOR_WALLET;
  const programId = process.env.E2E_PROGRAM_ID;
  if (rpc === undefined || wallet === undefined || programId === undefined) {
    if (process.env.E2E_REQUIRE_VALIDATOR === "1") {
      // Inside `make e2e` these tests must run, never be skipped silently.
      throw new Error("E2E_REQUIRE_VALIDATOR is set but the validator environment is missing");
    }
    return null;
  }
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(wallet, "utf8")) as number[]),
  );
  const connection = new Connection(rpc, "confirmed");
  const id = new PublicKey(programId);
  const program = createMeridianProgram(
    new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" }),
    id,
  );
  return { connection, admin, programId: id, program, config: findConfigPda(id).address };
}

export const SKIP_REASON =
  "needs the local validator that `make e2e` starts (ANCHOR_PROVIDER_URL, E2E_PROGRAM_ID)";

export function localFeedPda(programId: PublicKey, symbol: string, sourceSlot: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("local_feed"), symbolBytes(symbol), Buffer.from([sourceSlot])],
    programId,
  )[0];
}

export async function chainTime(v: Validator): Promise<number> {
  const time = await v.connection.getBlockTime(await v.connection.getSlot("confirmed"));
  if (time === null) {
    throw new Error("no block time");
  }
  return time;
}

let nextStrike = 0;

/** A fresh META market that closes `closeInSecs` from chain time; strikes never repeat. */
export async function createMarket(v: Validator, closeInSecs: number) {
  const { marketAddresses } = await import("@meridian/client");
  nextStrike += 1;
  // Unique across the three abuse-case files, which may run in parallel against one validator.
  const strikeCents =
    900_000_000n + BigInt(randomInt(0, 1_000_000)) * 1_000n + BigInt(nextStrike) * 1_000n;
  const key = { symbol: "META", tradingDate: 20_261_006, strikeCents };
  const closeTs = (await chainTime(v)) + closeInSecs;
  const a = marketAddresses(key, v.programId);
  const config = await v.program.account.config.fetch(v.config);
  await v.program.methods
    .createStrikeMarket(
      Array.from(symbolBytes("META")),
      new BN(strikeCents.toString()),
      key.tradingDate,
      new BN(closeTs),
    )
    .accountsStrict({
      config: v.config,
      automationAuthority: v.admin.publicKey,
      market: a.market,
      yesMint: a.yesMint,
      noMint: a.noMint,
      vault: a.vault,
      escrowUsdc: a.escrowUsdc,
      escrowYes: a.escrowYes,
      book: a.book,
      usdcMint: config.usdcMint,
      tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { market: a.market, closeTs };
}

export async function setLocalFeed(
  v: Validator,
  symbol: string,
  sourceSlot: number,
  cents: bigint,
  slot: number,
) {
  await v.program.methods
    .localOracleSet(
      Array.from(symbolBytes(symbol)),
      sourceSlot,
      new BN((cents * 10n ** 16n).toString()),
      new BN(slot),
    )
    .accountsStrict({
      config: v.config,
      localFeed: localFeedPda(v.programId, symbol, sourceSlot),
      admin: v.admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function waitUntil(v: Validator, ts: number): Promise<void> {
  const deadline = Date.now() + 180_000;
  while ((await chainTime(v)) < ts) {
    if (Date.now() > deadline) {
      throw new Error("the validator clock did not reach the close time");
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** The program error name of a failed call (`NotClosed`, `OracleStale`, …), or the raw message. */
export function programError(error: unknown): string {
  const named = (error as { error?: { errorCode?: { code?: string } } }).error?.errorCode?.code;
  return named ?? (error instanceof Error ? error.message : String(error));
}

export async function trySettle(
  v: Validator,
  market: PublicKey,
  feeds: readonly [PublicKey, PublicKey],
): Promise<string> {
  try {
    await v.program.methods
      .settleMarket()
      .accountsStrict({
        config: v.config,
        market,
        feedTiingo: feeds[0],
        feedTwelveData: feeds[1],
        payer: v.admin.publicKey,
      })
      .rpc();
    return "settled";
  } catch (error) {
    return programError(error);
  }
}
