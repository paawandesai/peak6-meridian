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
  placeholderSettlementJob,
  startService,
  type CronLike,
  type RunningService,
  type SignerDeps,
} from "automation";
import { FakeChain, RecordingAlerter, recordingLogger } from "automation/testing";
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
        },
        settlement: {
          ...placeholderSettlementJob(key),
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

  it("only calls create_strike_market and the permissionless settle_market", () => {
    const allowed = new Set(["createStrikeMarket", "settleMarket"]);
    const called = methodsCalled();
    expect([...called.keys()].filter((name) => !allowed.has(name))).toEqual([]);
    expect(called.has("createStrikeMarket")).toBe(true);
  });

  it("never references an admin-only instruction", () => {
    const forbidden = [
      "pause",
      "unpause",
      "updateConfig",
      "addStrike",
      "adminSettleOverride",
      "initializeConfig",
      "localOracleSet",
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

  /** The only production file allowed to sign: it builds `create_strike_market` and nothing else. */
  const MAY_SIGN = ["services/automation/src/cli/createMarkets.ts"];

  it("fails closed: only the market-creation file contains any signing or sending code", () => {
    const offenders = [...productionSources()]
      .filter(([, code]) => SIGNING_SURFACE.test(code))
      .map(([path]) => path)
      .sort();
    // M2-04 adds a settlement signing path: it must be added here deliberately, with its own
    // permissionless-only test, not slip in unnoticed.
    expect(offenders).toEqual(MAY_SIGN);
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
