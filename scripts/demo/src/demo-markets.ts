/**
 * `make demo-markets AS_OF=2026-10-09 CLOSE="2026-10-11 20:00" [TRADING_DATE=2026-10-11]
 *   [TICKERS=AAPL,MSFT] [CLOSES_JSON=path] [DRY_RUN=1]`
 *
 * Creates one demo session's markets on a non-trading day (see markets.ts), signed by the
 * automation authority (AUTOMATION_KEYPAIR, a JSON array) over MERIDIAN_DEVNET_RPC_URL, else
 * SOLANA_RPC_URL; devnet or a loopback validator only. Records the session in
 * deployments/demo-sessions.json. DRY_RUN sends nothing and writes no registry; without an RPC
 * URL it only prints the plan. Never prints the RPC URL or any key.
 */
import { parseArgs } from "node:util";

import { fetchPrevClose, parseKeypair, type HttpGet } from "automation";
import { Keypair } from "@solana/web3.js";

import { configKeys, connectProgram, demoMarketChain, safeMessage } from "./chain";
import { type ClosesTable, createCloseResolver, parseClosesJson, serializeCloses } from "./closes";
import { assertDemoTradingDate, parseCloseEt, parseIsoDate } from "./dates";
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
import { type DemoMarketChain, parseTickers, runDemoMarkets } from "./markets";
import { formatMarketsReport } from "./report";
import { parseRegistry, serializeRegistry } from "./registry";

const httpGet: HttpGet = (url, init) =>
  fetch(url, { headers: { ...init.headers }, signal: init.signal });

let rpcUrlForErrors: string | undefined;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "as-of": { type: "string" },
      close: { type: "string" },
      "trading-date": { type: "string" },
      tickers: { type: "string" },
      "closes-json": { type: "string" },
      "dry-run": { type: "string" },
      registry: { type: "string" },
      cache: { type: "string" },
    },
  });
  const env = parseDemoEnv(process.env);
  const now = new Date();
  const dryRun = isTruthy(values["dry-run"]);

  const asOfText = flag(values["as-of"]);
  const closeText = flag(values.close);
  if (asOfText === undefined || closeText === undefined) {
    throw new Error(
      'AS_OF and CLOSE are required: make demo-markets AS_OF=2026-10-09 CLOSE="2026-10-11 20:00"',
    );
  }
  const asOf = parseIsoDate(asOfText, "AS_OF");
  const closeTs = parseCloseEt(closeText, now);
  const requestedDate = flag(values["trading-date"]);
  const tradingDate =
    requestedDate === undefined
      ? undefined
      : assertDemoTradingDate(parseIsoDate(requestedDate, "TRADING_DATE"));
  const tickers = parseTickers(values.tickers);

  // Closes: CLOSES_JSON (no API calls), else the cache, else Tiingo + Twelve Data (cached).
  const closesPath = flag(values["closes-json"]);
  const file =
    closesPath === undefined
      ? undefined
      : parseClosesJson(
          readOptional(resolvePath(closesPath)) ?? missingFile("CLOSES_JSON", closesPath),
          "CLOSES_JSON",
        );
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
  let chain: DemoMarketChain | undefined;
  if (rpcUrl === undefined) {
    if (!dryRun) {
      throw new Error("set MERIDIAN_DEVNET_RPC_URL or SOLANA_RPC_URL");
    }
    console.log("DRY RUN without an RPC URL: existing markets are not checked");
  } else {
    if (!dryRun && env.AUTOMATION_KEYPAIR === undefined) {
      throw new Error("AUTOMATION_KEYPAIR is required to create markets (or pass DRY_RUN=1)");
    }
    const signer =
      env.AUTOMATION_KEYPAIR === undefined
        ? Keypair.generate()
        : parseKeypair(env.AUTOMATION_KEYPAIR);
    const handle = await connectProgram({ rpcUrl, programId: env.MERIDIAN_PROGRAM_ID, signer });
    console.log(`cluster ${handle.cluster} · program ${handle.program.programId.toBase58()}`);
    if (!dryRun) {
      const { automationAuthority } = await configKeys(handle.program);
      if (automationAuthority !== signer.publicKey.toBase58()) {
        throw new Error(
          `AUTOMATION_KEYPAIR is ${signer.publicKey.toBase58()}, but Config's automation authority is ${automationAuthority}`,
        );
      }
    }
    chain = await demoMarketChain(handle.program, !dryRun);
  }

  const report = await runDemoMarkets(
    { asOf, closeTs, tradingDate, tickers, dryRun, now },
    {
      closes,
      registry,
      chain,
      onCreated: (planned, signature) => {
        console.log(
          `created ${planned.key.symbol} ${planned.key.strikeCents.toString()}¢ ${signature}`,
        );
      },
    },
  );
  if (!dryRun) {
    writeText(registryPath, serializeRegistry(report.registry));
  }
  console.log(`\n${formatMarketsReport(report, dryRun)}`);
  console.log(
    dryRun ? "\nDRY RUN: nothing sent, registry not written" : `\nregistry: ${registryPath}`,
  );
  if (report.error !== undefined) {
    console.error(`\ndemo-markets stopped: ${safeMessage(new Error(report.error), rpcUrl)}`);
    return 1;
  }
  return 0;
}

function missingFile(name: string, path: string): never {
  throw new Error(`${name}: no file at ${path}`);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`demo-markets: ${safeMessage(error, rpcUrlForErrors)}`);
    process.exit(1);
  },
);
