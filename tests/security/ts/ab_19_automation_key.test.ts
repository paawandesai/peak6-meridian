// AB-19 · Automation key stolen (threat-model.md; NFR-08; M2-03 AC5): that key can only create
// markets; it cannot override, pause, change config or move user funds, and settlement is
// permissionless. Three guards on the off-chain side:
//  1. a service whose loaded key is NOT config.automation_authority attempts nothing with it
//     (no create_strike_market, no other transaction) yet reports it and keeps settling;
//  2. a missing or invalid key disables every job and leaks no key material;
//  3. the service's code can only ever call create_strike_market (and later the permissionless
//     settle_market): no admin-only program method appears anywhere in its production sources.
// The program-side half (the key cannot call admin instructions) is tests/security/program
// ab_06_admin_only.rs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  loadAutomationKey,
  startService,
  type CronLike,
  type RunningService,
  type SignerDeps,
} from "automation";
import {
  FakeChain,
  noopSettlementJob,
  RecordingAlerter,
  recordingLogger,
} from "automation/testing";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";

import { REPO_ROOT } from "./repo";

const TOKEN = "local-dev-token";
const running: RunningService[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
  }
});

/** Everything the service could do on chain, recorded. */
function recordingChain() {
  const chain = new FakeChain();
  const calls: string[] = [];
  const settlementRuns: string[] = [];
  const scheduled: { name: string; task: () => void | Promise<void> }[] = [];
  const cron: CronLike = {
    schedule: (_expression, task, options) => {
      scheduled.push({ name: options.name, task });
      return { stop: () => undefined };
    },
  };
  const marketOps = {
    exists: (p: Parameters<FakeChain["exists"]>[0]) => {
      calls.push("exists");
      return chain.exists(p);
    },
    create: (p: Parameters<FakeChain["create"]>[0]) => {
      calls.push("create_strike_market");
      return chain.create(p);
    },
  };
  return { chain, calls, settlementRuns, scheduled, cron, marketOps };
}

async function boot(signer: Keypair | null, configured: Keypair) {
  const r = recordingChain();
  const alerter = new RecordingAlerter();
  const logger = recordingLogger();
  const service = await startService({
    serviceToken: TOKEN,
    port: 0,
    host: "127.0.0.1",
    signer,
    withSigner: (key): Promise<SignerDeps> =>
      Promise.resolve({
        readAutomationAuthority: () => Promise.resolve(configured.publicKey),
        morning: {
          now: () => new Date("2026-10-06T12:30:00Z"), // 08:30 ET on a trading day
          sleep: () => Promise.resolve(),
          marketOps: r.marketOps,
          prevClose: () => Promise.reject(new Error("a mismatched key must not even read prices")),
          demoMode: "live",
          demoCloseInSecs: 3600,
          cluster: "devnet",
        },
        settlement: {
          ...noopSettlementJob(key),
          run: () => {
            r.settlementRuns.push("settlement");
            return Promise.resolve();
          },
        },
      }),
    cron: r.cron,
    alerter,
    log: logger.log,
  });
  running.push(service);
  const health = async () =>
    (await (
      await fetch(`http://127.0.0.1:${String(service.port)}/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as {
      status: string;
      unhealthy?: string;
      jobs: { name: string; scheduled: boolean; signer?: string; disabled?: string }[];
    };
  return { ...r, service, alerter, logger, health };
}

describe("AB-19 a service holding a key that is not the automation authority", () => {
  it("attempts no create_strike_market and no other transaction, even when every job fires", async () => {
    const loaded = Keypair.generate();
    const t = await boot(loaded, Keypair.generate());

    // Fire every scheduled job, repeatedly: nothing the key could sign is attempted.
    for (let i = 0; i < 3; i += 1) {
      for (const job of t.scheduled) {
        await job.task();
      }
    }
    expect(t.calls).toEqual([]);
    expect(t.chain.createCalls).toEqual([]);
    expect(t.scheduled.map((j) => j.name)).toEqual(["settlement"]);
  });

  it("keeps settling, signing with the loaded key, and reports the mismatch plus one alert", async () => {
    const loaded = Keypair.generate();
    const t = await boot(loaded, Keypair.generate());
    await t.scheduled[0]?.task();
    expect(t.settlementRuns).toEqual(["settlement"]);

    const health = await t.health();
    expect(health).toMatchObject({ status: "unhealthy", unhealthy: "automation key mismatch" });
    expect(health.jobs.find((j) => j.name === "settlement")).toMatchObject({
      scheduled: true,
      signer: loaded.publicKey.toBase58(),
    });
    expect(health.jobs.find((j) => j.name === "morning")).toMatchObject({ scheduled: false });
    expect(t.alerter.alerts).toHaveLength(1);
    expect(t.alerter.alerts[0]?.kind).toBe("automation_key_mismatch");
    // Only public keys appear in the alert; no secret key bytes.
    expect(JSON.stringify(t.alerter.alerts)).not.toContain(
      Buffer.from(loaded.secretKey).toString("base64"),
    );
  });

  it("does not run the catch-up either", async () => {
    const t = await boot(Keypair.generate(), Keypair.generate());
    expect(await t.service.catchUp).toBeNull();
    expect(t.calls).toEqual([]);
  });
});

describe("AB-19 a missing or invalid key", () => {
  it("disables every job and leaks no key material", async () => {
    const logger = recordingLogger();
    const { keypair } = loadAutomationKey("[7,7,7,KEYMATERIAL,7", logger.log);
    const t = await boot(keypair, Keypair.generate());
    expect(t.scheduled).toEqual([]);
    expect(t.calls).toEqual([]);
    expect((await t.health()).unhealthy).toBe("automation key missing or invalid");
    const everything = JSON.stringify([
      logger.lines,
      t.logger.lines,
      t.alerter.alerts,
      await t.health(),
    ]);
    expect(everything).not.toContain("KEYMATERIAL");
  });
});

/** Comments removed, so prose mentioning an API cannot trip (or hide) a code scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("AB-19 what the automation service can ever send", () => {
  /** Production sources of the service as repo-relative path → code without comments. */
  function productionSources(): Map<string, string> {
    const root = join(REPO_ROOT, "services/automation/src");
    const files = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry !== "testing") {
            walk(path);
          }
        } else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
          files.set(relative(REPO_ROOT, path), stripComments(readFileSync(path, "utf8")));
        }
      }
    };
    walk(root);
    return files;
  }

  /** Program methods called by production sources of the service (tests and doubles excluded). */
  function methodsCalled(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const [path, code] of productionSources()) {
      for (const match of code.matchAll(/\bmethods\s*\.\s*([A-Za-z0-9_]+)\s*\(/g)) {
        const name = match[1] ?? "";
        found.set(name, [...(found.get(name) ?? []), path]);
      }
    }
    return found;
  }

  /**
   * Which production file may call which program method. `settle_market` is permissionless
   * (the payer only pays fees); `local_oracle_set` is the admin-only, local-validator-only test
   * oracle: it is built solely by the local adapter, signed by an injected Config-admin keypair
   * that is never the automation key, and chosen only when the verified cluster is localnet.
   */
  const METHODS_BY_FILE: Record<string, string[]> = {
    "services/automation/src/cli/createMarkets.ts": ["createStrikeMarket"],
    // The Pyth settlement path (D-055, off by default): settle_market with the Ed25519 index.
    "services/automation/src/pythSettle.ts": ["settleMarket"],
    "services/automation/src/settleTx.ts": ["settleMarket"],
    "services/automation/src/switchboard.ts": ["localOracleSet"],
  };

  it("each program method is called only from the file allowed to call it", () => {
    const called = methodsCalled();
    for (const [name, files] of called) {
      for (const file of files) {
        expect(METHODS_BY_FILE[file] ?? [], `${name} in ${file}`).toContain(name);
      }
    }
    expect(called.has("createStrikeMarket")).toBe(true);
    expect(called.has("settleMarket")).toBe(true);
  });

  it("never references an admin-only instruction", () => {
    const forbidden = [
      "pause",
      "unpause",
      "updateConfig",
      "addStrike",
      "adminSettleOverride",
      "initializeConfig",
    ];
    const called = methodsCalled();
    for (const name of forbidden) {
      expect(called.has(name), name).toBe(false);
    }
  });

  /**
   * Every way the service's code could sign or send something: sending helpers, `.rpc()`,
   * `.signers()`, building instructions or transactions, computed `methods[...]` access, and any
   * `SystemProgram` call other than reading its address.
   */
  const SIGNING_SURFACE =
    /\b(?:sendTransaction|sendRawTransaction|sendAndConfirm|signTransaction|signAllTransactions|VersionedTransaction|new\s+Transaction)\b|\.\s*(?:rpc|signers|instruction|transaction|simulate)\s*\(|\bprogram\s*\.\s*instruction\b|\bmethods\s*\[|SystemProgram\s*\.\s*(?!programId\b)/;

  /**
   * The only production files allowed to build or send transactions: market creation
   * (`create_strike_market`), the settlement transaction builder (`settle_market`, permissionless),
   * the local-oracle / Switchboard adapters, the Pyth settlement builder (`settle_market`, payer
   * only: see the test below), and the executor that signs and sends what they plan.
   */
  const MAY_SIGN = [
    "services/automation/src/cli/createMarkets.ts",
    "services/automation/src/executor.ts",
    "services/automation/src/pythSettle.ts",
    "services/automation/src/settleTx.ts",
    "services/automation/src/switchboard.ts",
  ];

  it("fails closed: only the allowed files contain any signing or sending code", () => {
    const offenders = [...productionSources()]
      .filter(([, code]) => SIGNING_SURFACE.test(code))
      .map(([path]) => path)
      .sort();
    // A new signing path must be added to MAY_SIGN deliberately, with its own test.
    expect(offenders).toEqual(MAY_SIGN);
  });

  it("the Pyth settlement path builds only settle_market and adds no signer beyond the payer", () => {
    const code = productionSources().get("services/automation/src/pythSettle.ts") ?? "";
    expect([...code.matchAll(/\bmethods\s*\.\s*([A-Za-z0-9_]+)/g)].map((m) => m[1])).toEqual([
      "settleMarket",
    ]);
    // Every send passes an empty extra-signer list: the executor signs with the payer alone.
    const sends = [...code.matchAll(/\.send\(([^)]*)\)/g)].map((m) => m[1]);
    expect(sends).toEqual(["tx, []"]);
    expect(code).not.toMatch(/Keypair/);
  });

  it("the test-only local oracle (admin-signed local_oracle_set) is reachable only on localnet", () => {
    const sources = productionSources();
    // Chosen solely by selectAdapter's cluster switch ...
    const select = sources.get("services/automation/src/switchboard.ts") ?? "";
    expect(select).toMatch(/cluster === "localnet" \? params\.local\(\) : params\.switchboard\(\)/);
    // ... and the admin keypair is only ever loaded when the verified cluster is localnet.
    for (const file of [
      "services/automation/src/main.ts",
      "services/automation/src/settle-now.ts",
    ]) {
      const code = sources.get(file) ?? "";
      expect(code, file).toMatch(/cluster === "localnet" &&\s*env\.ADMIN_KEYPAIR_PATH/);
    }
    // No other file builds the local adapter.
    const builders = [...sources]
      .filter(([, code]) => /localOracleAdapter\s*\(/.test(code))
      .map(([path]) => path);
    expect(builders.sort()).toEqual([
      "services/automation/src/runtime.ts",
      "services/automation/src/switchboard.ts",
    ]);
  });

  it("the scan itself catches the patterns it is meant to (guard against a vacuous regex)", () => {
    for (const code of [
      "await connection.sendTransaction(tx)",
      "await provider.sendAndConfirm(tx, [key])",
      "program.methods.pause().rpc()",
      "program.methods.x().signers([k])",
      "const ix = await program.methods.x().instruction()",
      "program.methods[name]()",
      "new Transaction().add(SystemProgram.transfer({}))",
      "program.instruction.foo()",
    ]) {
      expect(SIGNING_SURFACE.test(code), code).toBe(true);
    }
    for (const code of ["SystemProgram.programId", "// await program.methods.pause().rpc()"]) {
      expect(SIGNING_SURFACE.test(stripComments(code)), code).toBe(false);
    }
  });

  it("never uses computed method names, which would hide the instruction being called", () => {
    for (const [path, code] of productionSources()) {
      expect(/\bmethods\s*\[/.test(code), path).toBe(false);
    }
  });
});
