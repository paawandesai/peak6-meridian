/**
 * `make demo-settle TRADING_DATE=2026-10-11 [CLOSES_JSON=path] [DRY_RUN=1]`
 *
 * Settles every OPEN market of a demo trading date by `admin_settle_override` at the simulated
 * session's real close (see settle.ts), signed by the admin key (ADMIN_KEYPAIR_PATH, a JSON
 * keypair file) over MERIDIAN_DEVNET_RPC_URL, else SOLANA_RPC_URL; devnet or a loopback
 * validator only. DRY_RUN reads the chain but sends nothing and writes no registry. Never
 * prints the RPC URL or any key.
 */
import { parseArgs } from "node:util";

import { fetchPrevClose, readKeypairFile, type HttpGet } from "automation";
import { Keypair } from "@solana/web3.js";

import { connectProgram, demoSettleChain, safeMessage } from "./chain";
import { type ClosesTable, createCloseResolver, parseClosesJson, serializeCloses } from "./closes";
import { parseIsoDate } from "./dates";
import {
  DEFAULT_CACHE,
  DEFAULT_REGISTRY,
  flag,
  isTruthy,
  parseDemoEnv,
  readOptional,
  resolvePath,
  rpcUrlOf,
  writeText,
} from "./env";
import { formatSettleReport } from "./report";
import { parseRegistry, serializeRegistry } from "./registry";
import { runDemoSettle } from "./settle";

const httpGet: HttpGet = (url, init) =>
  fetch(url, { headers: { ...init.headers }, signal: init.signal });

let rpcUrlForErrors: string | undefined;

function loadAdmin(path: string | undefined, dryRun: boolean): Keypair | undefined {
  if (path === undefined) {
    if (dryRun) {
      return undefined;
    }
    throw new Error("ADMIN_KEYPAIR_PATH is required to settle (or pass DRY_RUN=1)");
  }
  try {
    return readKeypairFile(resolvePath(path));
  } catch {
    // Never echo the file's content or a parse snippet of it.
    throw new Error("ADMIN_KEYPAIR_PATH is not a readable JSON keypair file (64-byte array)");
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "trading-date": { type: "string" },
      "closes-json": { type: "string" },
      "dry-run": { type: "string" },
      registry: { type: "string" },
      cache: { type: "string" },
    },
  });
  const env = parseDemoEnv(process.env);
  const dryRun = isTruthy(values["dry-run"]);
  const dateText = flag(values["trading-date"]);
  if (dateText === undefined) {
    throw new Error("TRADING_DATE is required: make demo-settle TRADING_DATE=2026-10-11");
  }
  const tradingDate = parseIsoDate(dateText, "TRADING_DATE");

  const closesPath = flag(values["closes-json"]);
  const fileText = closesPath === undefined ? null : readOptional(resolvePath(closesPath));
  if (closesPath !== undefined && fileText === null) {
    throw new Error(`CLOSES_JSON: no file at ${closesPath}`);
  }
  const file = fileText === null ? undefined : parseClosesJson(fileText, "CLOSES_JSON");
  const cachePath = resolvePath(flag(values.cache) ?? DEFAULT_CACHE);
  const cacheText = readOptional(cachePath);
  const cache: ClosesTable = cacheText === null ? {} : parseClosesJson(cacheText, "closes cache");
  const keys =
    env.TIINGO_API_KEY !== undefined && env.TWELVEDATA_API_KEY !== undefined
      ? { tiingoApiKey: env.TIINGO_API_KEY, twelveDataApiKey: env.TWELVEDATA_API_KEY }
      : undefined;
  const closes = createCloseResolver({
    file,
    cache,
    fetchClose:
      keys === undefined
        ? undefined
        : (ticker, date) => fetchPrevClose({ http: httpGet, ...keys }, ticker, date),
    onCached: () => {
      writeText(cachePath, serializeCloses(cache));
    },
  });

  const registryPath = resolvePath(flag(values.registry) ?? DEFAULT_REGISTRY);
  const registry = parseRegistry(readOptional(registryPath), registryPath);

  const rpcUrl = rpcUrlOf(env);
  rpcUrlForErrors = rpcUrl;
  if (rpcUrl === undefined) {
    throw new Error("set MERIDIAN_DEVNET_RPC_URL or SOLANA_RPC_URL");
  }
  const admin = loadAdmin(env.ADMIN_KEYPAIR_PATH, dryRun);
  const handle = await connectProgram({
    rpcUrl,
    programId: env.MERIDIAN_PROGRAM_ID,
    signer: admin ?? Keypair.generate(),
  });
  console.log(`cluster ${handle.cluster} · program ${handle.program.programId.toBase58()}`);

  const report = await runDemoSettle(
    { tradingDate, now: new Date(), dryRun, admin: admin?.publicKey.toBase58() },
    { registry, chain: demoSettleChain(handle.program, !dryRun), closes },
  );
  if (!dryRun && report.registry !== registry) {
    writeText(registryPath, serializeRegistry(report.registry));
    console.log(`registry updated with the ${report.asOf} closes: ${registryPath}`);
  }
  console.log(`\n${formatSettleReport(report, dryRun)}`);
  return report.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`demo-settle: ${safeMessage(error, rpcUrlForErrors)}`);
    process.exit(1);
  },
);
