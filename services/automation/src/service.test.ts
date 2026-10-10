import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadAutomationKey } from "./config";
import { fetchPrevClose } from "./prevCloses";
import { type CronLike } from "./scheduler";
import { startService, type RunningService } from "./service";
import { fakeSourcesHttp } from "./testing/fakeHttp";
import {
  FakeChain,
  FakeClock,
  noopSettlementJob,
  RecordingAlerter,
  recordingLogger,
} from "./testing/harness";

const TOKEN = "local-dev-token";
const running: RunningService[] = [];

function fakeCron() {
  const scheduled: { expression: string; name: string; task: () => void | Promise<void> }[] = [];
  const stopped: string[] = [];
  const cron: CronLike = {
    schedule: (expression, task, options) => {
      scheduled.push({ expression, name: options.name, task });
      return { stop: () => void stopped.push(options.name) };
    },
  };
  return { cron, scheduled, stopped };
}

async function start(options: {
  loaded: Keypair | null;
  configured: Keypair;
  settlementCrashes?: boolean;
  /** Defaults to 07:00 ET on a trading day: before the 08:00 trigger, so no catch-up runs. */
  clockStart?: Date;
}) {
  const cronFake = fakeCron();
  const alerter = new RecordingAlerter();
  const chain = new FakeChain();
  const clock = new FakeClock(options.clockStart ?? new Date("2026-10-06T11:00:00Z"));
  const logger = recordingLogger();
  const http = fakeSourcesHttp({
    closes: {
      AAPL: 23_000,
      MSFT: 41_500,
      GOOGL: 17_500,
      AMZN: 22_000,
      NVDA: 18_000,
      META: 68_000,
      TSLA: 25_000,
    },
    date: "2026-10-05",
  });
  const builtWith: Keypair[] = [];
  const service = await startService({
    serviceToken: TOKEN,
    port: 0,
    host: "127.0.0.1",
    signer: options.loaded,
    withSigner: (signer) => {
      builtWith.push(signer);
      return Promise.resolve({
        readAutomationAuthority: () => Promise.resolve(options.configured.publicKey),
        morning: {
          now: clock.now,
          sleep: clock.sleep,
          marketOps: chain,
          prevClose: (ticker, date) =>
            fetchPrevClose({ http, tiingoApiKey: "k", twelveDataApiKey: "k" }, ticker, date),
          demoMode: "live" as const,
          demoCloseInSecs: 3600,
          cluster: "devnet",
        },
        settlement:
          options.settlementCrashes === true
            ? {
                ...noopSettlementJob(signer),
                run: () => Promise.reject(new Error("settlement exploded")),
              }
            : noopSettlementJob(signer),
      });
    },
    cron: cronFake.cron,
    alerter,
    log: logger.log,
  });
  running.push(service);
  return { service, alerter, chain, logger, builtWith, clock, ...cronFake };
}

function signerDeps(signer: Keypair) {
  return {
    readAutomationAuthority: () => Promise.resolve(signer.publicKey),
    morning: {
      now: () => new Date(),
      sleep: () => Promise.resolve(),
      marketOps: new FakeChain(),
      prevClose: () => Promise.reject(new Error("unused")),
      demoMode: "live" as const,
      demoCloseInSecs: 3600,
      cluster: "devnet",
    },
    settlement: noopSettlementJob(signer),
  };
}

function baseDeps(signer: Keypair, alerter: RecordingAlerter) {
  return {
    serviceToken: TOKEN,
    port: 0,
    host: "127.0.0.1",
    signer,
    withSigner: (s: Keypair) => Promise.resolve(signerDeps(s)),
    cron: fakeCron().cron,
    alerter,
    log: recordingLogger().log,
  };
}

async function health(service: RunningService, token: string | null = TOKEN) {
  return fetch(`http://127.0.0.1:${String(service.port)}/health`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
  }
});

describe("startService with the right automation key", () => {
  it("schedules the morning (08:00 ET) and settlement jobs and reports ok", async () => {
    const key = Keypair.generate();
    const t = await start({ loaded: key, configured: key });
    expect(t.service.degraded).toBeNull();
    expect(t.scheduled.map((s) => s.name).sort()).toEqual(["morning", "settlement"]);
    expect(t.scheduled.find((s) => s.name === "morning")?.expression).toBe("0 8 * * 1-5");
    expect(t.alerter.alerts).toEqual([]);

    const response = await health(t.service);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      service: "automation",
      status: "ok",
      lastMorning: null,
      lastSettlement: null,
      failures: [],
    });
    expect(body).not.toHaveProperty("unhealthy");
  });

  it("runs the morning job from its cron handler and reports it in /health", async () => {
    const key = Keypair.generate();
    const t = await start({ loaded: key, configured: key });
    await t.clock.sleep(3_600_000); // 08:00 ET
    await t.scheduled.find((s) => s.name === "morning")?.task();
    expect(t.chain.markets.size).toBe(38);
    const body = (await (await health(t.service)).json()) as {
      lastMorning: { status: string; created: number };
    };
    expect(body.lastMorning).toMatchObject({ status: "ok", created: 38 });
  });

  it("reports the settlement job with the key that signs it", async () => {
    const key = Keypair.generate();
    const t = await start({ loaded: key, configured: key });
    const body = (await (await health(t.service)).json()) as {
      jobs: { name: string; signer?: string; scheduled: boolean }[];
    };
    expect(body.jobs.find((j) => j.name === "settlement")).toMatchObject({
      scheduled: true,
      signer: key.publicKey.toBase58(),
    });
  });

  it("runs the startup check once, and a failing check is logged, not fatal", async () => {
    const key = Keypair.generate();
    let calls = 0;
    const logger = recordingLogger();
    const service = await startService({
      ...baseDeps(key, new RecordingAlerter()),
      log: logger.log,
      withSigner: (signer) =>
        Promise.resolve({
          ...signerDeps(signer),
          startupCheck: () => {
            calls += 1;
            return Promise.reject(new Error("balance rpc down https://rpc.example/?k=SECRET"));
          },
        }),
    });
    running.push(service);
    expect(calls).toBe(1);
    expect(service.degraded).toBeNull();
    expect(logger.lines.map((l) => l.event)).toContain("startup_check_failed");
    expect(JSON.stringify(logger.lines)).not.toContain("SECRET");
  });

  it("records a crashed job in /health and alerts once (never swallowed)", async () => {
    const key = Keypair.generate();
    const t = await start({ loaded: key, configured: key, settlementCrashes: true });
    await t.scheduled.find((s) => s.name === "settlement")?.task();
    expect(t.alerter.alerts).toHaveLength(1);
    expect(t.alerter.alerts[0]).toMatchObject({
      kind: "job_crashed",
      details: { job: "settlement" },
    });
    const body = (await (await health(t.service)).json()) as {
      failures: { job: string; message: string }[];
    };
    expect(body.failures).toEqual([
      expect.objectContaining({ job: "settlement", message: "crashed: settlement exploded" }),
    ]);
  });

  it("stops its jobs and the server", async () => {
    const key = Keypair.generate();
    const t = await start({ loaded: key, configured: key });
    await t.service.stop();
    expect(t.stopped.sort()).toEqual(["morning", "settlement"]);
    await expect(health(t.service)).rejects.toThrow();
  });
});

describe("degraded mode: automation key mismatch (AC5)", () => {
  it("keeps HTTP and /health up reporting the mismatch, disables only the morning job, alerts once, and still schedules settlement", async () => {
    const loaded = Keypair.generate();
    const t = await start({ loaded, configured: Keypair.generate() });

    // 1. The HTTP server and /health stay up and report the mismatch (still behind the token).
    expect((await health(t.service, null)).status).toBe(401);
    const response = await health(t.service);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      unhealthy: string;
      jobs: { name: string; scheduled: boolean; disabled?: string; signer?: string }[];
    };
    expect(body.status).toBe("unhealthy");
    expect(body.unhealthy).toBe("automation key mismatch");
    expect(t.service.degraded).toBe("automation key mismatch");

    // 2. Only the morning job is disabled: it is not scheduled and is reported as disabled.
    expect(t.scheduled.map((s) => s.name)).not.toContain("morning");
    expect(body.jobs).toContainEqual({
      name: "morning",
      scheduled: false,
      disabled: "automation key mismatch",
    });

    // 3. Exactly one alert is sent, naming both public keys but no secret.
    expect(t.alerter.alerts).toHaveLength(1);
    expect(t.alerter.alerts[0]?.kind).toBe("automation_key_mismatch");

    // 4. The settlement job is still scheduled (settle_market is permissionless, NFR-04).
    expect(t.scheduled.map((s) => s.name)).toEqual(["settlement"]);
    expect(body.jobs).toContainEqual(
      expect.objectContaining({ name: "settlement", scheduled: true }),
    );
    await t.scheduled[0]?.task();

    // Nothing was created and the failure is visible in /health.
    expect(t.chain.createCalls).toEqual([]);
    const failures = (await (await health(t.service)).json()) as {
      failures: { job: string; message: string }[];
    };
    expect(failures.failures).toEqual([
      expect.objectContaining({ job: "startup", message: "automation key mismatch" }),
    ]);
  });

  it("retries the startup config read, and recovers without any alert", async () => {
    const key = Keypair.generate();
    const alerter = new RecordingAlerter();
    const sleeps: number[] = [];
    let reads = 0;
    const service = await startService({
      ...baseDeps(key, alerter),
      withSigner: (signer) =>
        Promise.resolve({
          ...signerDeps(signer),
          readAutomationAuthority: () =>
            ++reads < 3 ? Promise.reject(new Error("rpc blip")) : Promise.resolve(key.publicKey),
        }),
      sleep: (ms) => Promise.resolve(void sleeps.push(ms)),
    });
    running.push(service);
    expect(reads).toBe(3);
    expect(sleeps).toEqual([2_000, 4_000]);
    expect(service.degraded).toBeNull();
    expect(alerter.alerts).toEqual([]);
  });

  it("alerts once with startup_failed and then aborts when the config stays unreadable", async () => {
    const key = Keypair.generate();
    const alerter = new RecordingAlerter();
    const sleeps: number[] = [];
    await expect(
      startService({
        ...baseDeps(key, alerter),
        withSigner: (signer) =>
          Promise.resolve({
            ...signerDeps(signer),
            readAutomationAuthority: () =>
              Promise.reject(new Error("account not found https://rpc.example/?k=SECRET")),
          }),
        sleep: (ms) => Promise.resolve(void sleeps.push(ms)),
      }),
    ).rejects.toThrow("account not found");
    expect(sleeps).toEqual([2_000, 4_000]);
    expect(alerter.alerts).toHaveLength(1);
    expect(alerter.alerts[0]).toMatchObject({ kind: "startup_failed" });
    expect(JSON.stringify(alerter.alerts)).not.toContain("SECRET");
  });
});

describe("startup catch-up", () => {
  const key = Keypair.generate();
  // 2026-10-06 (a Tuesday): 08:00 ET = 12:00Z, close 16:00 ET = 20:00Z.
  const at = (iso: string) => new Date(iso);

  it("runs the morning job at startup when it is past 08:00 ET on a trading day (restart or downtime)", async () => {
    const t = await start({ loaded: key, configured: key, clockStart: at("2026-10-06T12:20:00Z") });
    const result = await t.service.catchUp;
    expect(result).toMatchObject({ status: "ok", created: 38 });
    expect(t.chain.markets.size).toBe(38);
    const body = (await (await health(t.service)).json()) as { lastMorning: { status: string } };
    expect(body.lastMorning.status).toBe("ok");
  });

  it("alerts once when the catch-up cannot create the markets", async () => {
    const t = await start({ loaded: key, configured: key, clockStart: at("2026-10-06T12:45:00Z") });
    t.chain.failCreates = { remaining: 1_000, message: "rpc down" };
    expect(await t.service.catchUp).toMatchObject({ status: "failed" });
    expect(t.alerter.alerts).toHaveLength(1);
  });

  it("does nothing before 08:00 ET, after the close, or on a holiday or weekend", async () => {
    for (const iso of [
      "2026-10-06T11:59:00Z", // 07:59 ET
      "2026-10-06T20:00:00Z", // 16:00 ET, closed
      "2026-11-26T15:00:00Z", // Thanksgiving
      "2026-10-10T15:00:00Z", // Saturday
    ]) {
      const t = await start({ loaded: key, configured: key, clockStart: at(iso) });
      expect(await t.service.catchUp, iso).toBeNull();
      expect(t.chain.createCalls, iso).toEqual([]);
      expect(t.alerter.alerts, iso).toEqual([]);
      await t.service.stop();
    }
  });

  it("is skipped in degraded mode (the morning job is disabled)", async () => {
    const t = await start({
      loaded: Keypair.generate(),
      configured: key,
      clockStart: at("2026-10-06T12:20:00Z"),
    });
    expect(await t.service.catchUp).toBeNull();
    expect(t.chain.createCalls).toEqual([]);
  });
});

describe("degraded mode: automation key missing or invalid (AC5b)", () => {
  it("stays up, reports the problem, alerts once and disables both jobs", async () => {
    const t = await start({ loaded: null, configured: Keypair.generate() });

    // The process stays up and /health still demands the token.
    expect((await health(t.service, null)).status).toBe(401);
    const response = await health(t.service);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      unhealthy: string;
      jobs: { name: string; scheduled: boolean; disabled?: string }[];
    };
    expect(body.status).toBe("unhealthy");
    expect(body.unhealthy).toBe("automation key missing or invalid");
    expect(t.service.degraded).toBe("automation key missing or invalid");

    // Both jobs are disabled: nothing scheduled, nothing built (there is no signer).
    expect(t.scheduled).toEqual([]);
    expect(t.builtWith).toEqual([]);
    expect(body.jobs).toEqual([
      { name: "morning", scheduled: false, disabled: "automation key missing or invalid" },
      { name: "settlement", scheduled: false, disabled: "automation key missing or invalid" },
    ]);

    // Exactly one alert.
    expect(t.alerter.alerts).toHaveLength(1);
    expect(t.alerter.alerts[0]?.kind).toBe("automation_key_missing");
    // The alert tells the operator how to recover (AC5b).
    expect(t.alerter.alerts[0]?.summary).toContain("settle-now");
    expect(t.alerter.alerts[0]?.summary).toContain("redeploy");
  });

  it("leaks no key material, not even a fragment, into logs, alerts or /health", async () => {
    const logger = recordingLogger();
    const garbage = "[11,22,33,KEYFRAGMENT-9f8e7d,44";
    const { keypair, problem } = loadAutomationKey(garbage, logger.log);
    expect(keypair).toBeNull();
    expect(problem).toMatch(/AUTOMATION_KEYPAIR/);

    const alerter = new RecordingAlerter();
    const service = await startService({
      serviceToken: TOKEN,
      port: 0,
      host: "127.0.0.1",
      signer: keypair,
      withSigner: () => Promise.reject(new Error("must not be called")),
      cron: fakeCron().cron,
      alerter,
      log: logger.log,
    });
    running.push(service);
    const body = await (await health(service)).text();
    const everything = JSON.stringify([logger.lines, alerter.alerts]) + body;
    for (const fragment of ["KEYFRAGMENT", "9f8e7d", "11,22", "33,KEY"]) {
      expect(everything).not.toContain(fragment);
    }
    expect(alerter.alerts).toHaveLength(1);
  });

  it("treats an unset or blank key the same way", async () => {
    for (const text of [undefined, "", "   "]) {
      expect(loadAutomationKey(text, recordingLogger().log)).toEqual({
        keypair: null,
        problem: "AUTOMATION_KEYPAIR is not set",
      });
    }
  });
});
