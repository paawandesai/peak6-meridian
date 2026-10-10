// Seeds a local validator for the Markets page (M1-12): test-USDC mint, config with the MAG7
// tickers and a few strike markets, via @meridian/client. Prints the NEXT_PUBLIC_* lines to put
// in `.env`. Local only; refuses any RPC URL that is not loopback.
//
//   pnpm --filter app seed:local
//
// Environment (all optional):
//   SEED_RPC_URL       validator RPC (default http://127.0.0.1:8899)
//   SEED_PROGRAM_ID    deployed program ID (default: the ID in the IDL)
//   SEED_KEYPAIR_PATH  payer = admin = automation authority (default ~/.config/solana/id.json)
//   SEED_WALLET        wallet that receives 1,000 test-USDC (for the balance display)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import {
  configParamsArg,
  configParamsBatches,
  createMeridianProgram,
  DEFAULT_MAX_CONF_BPS,
  DEFAULT_MAX_STALENESS_SLOTS,
  DEFAULT_OVERRIDE_DELAY_SECS,
  findConfigPda,
  MERIDIAN_PROGRAM_ID,
  marketAddresses,
  parseUsdc,
  PYTH_DISABLED,
  dollarsToStrikeCents,
  symbolBytes,
  type TickerInput,
} from "@meridian/client";
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;

/** Strikes in whole dollars per ticker; every other ticker gets none. */
const STRIKES: Readonly<Record<string, readonly bigint[]>> = {
  AAPL: [220n, 230n, 240n],
  MSFT: [430n, 440n],
  NVDA: [130n, 140n, 150n],
};

const rpcUrl = process.env.SEED_RPC_URL ?? "http://127.0.0.1:8899";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpcUrl)) {
  throw new Error(`seed:local only runs against a local validator, not ${rpcUrl}`);
}

function loadKeypair(path: string): Keypair {
  const secret: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(secret) || !secret.every((n) => typeof n === "number")) {
    throw new Error(`${path} is not a keypair JSON array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret as number[]));
}

/** ET calendar date (`YYYYMMDD`) of `date`, via a real timezone database. */
function etTradingDate(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return Number(parts.replaceAll("-", ""));
}

async function main(): Promise<void> {
  const payer = loadKeypair(
    resolve(process.env.SEED_KEYPAIR_PATH ?? `${homedir()}/.config/solana/id.json`),
  );
  const programId =
    process.env.SEED_PROGRAM_ID === undefined
      ? MERIDIAN_PROGRAM_ID
      : new PublicKey(process.env.SEED_PROGRAM_ID);
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = createMeridianProgram(provider, programId);

  const usdcMint = await createMint(connection, payer, payer.publicKey, null, 6);
  console.error(`test-USDC mint ${usdcMint.toBase58()}`);

  const tickers: TickerInput[] = MAG7.map((symbol, index) => ({
    symbol,
    feeds: [Keypair.generate().publicKey, Keypair.generate().publicKey],
    feedHashes: [new Uint8Array(32).fill(index + 1), new Uint8Array(32).fill(index + 101)],
  }));
  const batches = configParamsBatches(
    {
      automationAuthority: payer.publicKey,
      maxStalenessSlots: DEFAULT_MAX_STALENESS_SLOTS,
      maxConfBps: DEFAULT_MAX_CONF_BPS,
      overrideDelaySecs: DEFAULT_OVERRIDE_DELAY_SECS,
      pyth: PYTH_DISABLED,
    },
    tickers,
  );
  const [first, ...rest] = batches;
  if (first === undefined) throw new Error("no config batches");
  await program.methods
    .initializeConfig(configParamsArg(first))
    .accounts({
      admin: payer.publicKey,
      usdcMint,
    } as never)
    .rpc();
  for (const batch of rest) {
    await program.methods
      .updateConfig(configParamsArg(batch))
      .accounts({
        admin: payer.publicKey,
        usdcMint,
      } as never)
      .rpc();
  }
  console.error(`config ${findConfigPda(programId).address.toBase58()}`);

  const now = new Date();
  const tradingDate = etTradingDate(now);
  const closeTs = new BN(Math.floor(now.getTime() / 1000) + 6 * 3600);
  const payerUsdc = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    usdcMint,
    payer.publicKey,
  );
  await mintTo(connection, payer, usdcMint, payerUsdc.address, payer, parseUsdc("1000"));

  let created = 0;
  for (const [symbol, strikes] of Object.entries(STRIKES)) {
    for (const dollars of strikes) {
      const strikeCents = dollarsToStrikeCents(dollars);
      await program.methods
        .createStrikeMarket(
          Array.from(symbolBytes(symbol)),
          new BN(strikeCents.toString()),
          tradingDate,
          closeTs,
        )
        .accounts({ automationAuthority: payer.publicKey, usdcMint } as never)
        .rpc();
      created += 1;
      // Mint a few pairs on the first market of each ticker so "pairs outstanding" is non-zero.
      if (dollars === strikes[0]) {
        const addr = marketAddresses({ symbol, tradingDate, strikeCents }, programId);
        const yes = await createAssociatedTokenAccountIdempotent(
          connection,
          payer,
          addr.yesMint,
          payer.publicKey,
        );
        const no = await createAssociatedTokenAccountIdempotent(
          connection,
          payer,
          addr.noMint,
          payer.publicKey,
        );
        await program.methods
          .mintPair(new BN(3))
          .accounts({
            market: addr.market,
            user: payer.publicKey,
            userUsdc: payerUsdc.address,
            userYes: yes,
            userNo: no,
          } as never)
          .rpc();
      }
    }
  }
  console.error(`created ${created} markets for ${tradingDate} (3 pairs on one per ticker)`);

  if (process.env.SEED_WALLET !== undefined) {
    const wallet = new PublicKey(process.env.SEED_WALLET);
    const account = await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, wallet);
    await mintTo(connection, payer, usdcMint, account.address, payer, parseUsdc("1000"));
    console.error(`minted 1,000 test-USDC to ${wallet.toBase58()}`);
  }

  console.log(`NEXT_PUBLIC_CLUSTER=localnet`);
  console.log(`NEXT_PUBLIC_RPC_URL=${rpcUrl}`);
  console.log(`NEXT_PUBLIC_PROGRAM_ID=${programId.toBase58()}`);
  console.log(`NEXT_PUBLIC_USDC_MINT=${usdcMint.toBase58()}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
