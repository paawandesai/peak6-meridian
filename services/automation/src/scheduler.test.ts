import * as nodeCron from "node-cron";
import { describe, expect, it } from "vitest";

import { MORNING_CRON } from "./jobs/morning";
import { SETTLEMENT_CRON } from "./jobs/settle";
import { defaultCron, scheduleJobs, type CronLike } from "./scheduler";
import { recordingLogger } from "./testing/harness";

function fakeCron() {
  const calls: {
    expression: string;
    task: () => void | Promise<void>;
    options: { timezone: string; name: string; noOverlap: boolean };
  }[] = [];
  const stopped: string[] = [];
  const cron: CronLike = {
    schedule: (expression, task, options) => {
      calls.push({ expression, task, options });
      return { stop: () => stopped.push(options.name) };
    },
  };
  return { cron, calls, stopped };
}

describe("scheduleJobs", () => {
  it("schedules each job in America/New_York without overlap", () => {
    const { cron, calls } = fakeCron();
    const jobs = scheduleJobs(
      cron,
      [{ name: "morning", cron: MORNING_CRON, run: () => Promise.resolve() }],
      recordingLogger().log,
    );
    expect(jobs.map((j) => j.name)).toEqual(["morning"]);
    expect(calls[0]).toMatchObject({
      expression: "0 8 * * 1-5",
      options: { timezone: "America/New_York", name: "morning", noOverlap: true },
    });
  });

  it("logs a crashing job instead of rethrowing", async () => {
    const { cron, calls } = fakeCron();
    const logger = recordingLogger();
    scheduleJobs(
      cron,
      [
        {
          name: "boom",
          cron: "* * * * *",
          run: () => Promise.reject(new Error("failed https://rpc.example/?key=SECRET")),
        },
      ],
      logger.log,
    );
    await calls[0]?.task();
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: "error", event: "job_crashed" });
    expect(JSON.stringify(logger.lines)).not.toContain("SECRET");
  });

  it("hands a crash to onCrash and survives a failing report", async () => {
    const { cron, calls } = fakeCron();
    const logger = recordingLogger();
    const reported: [string, string][] = [];
    scheduleJobs(
      cron,
      [{ name: "boom", cron: "* * * * *", run: () => Promise.reject(new Error("bad state")) }],
      logger.log,
      (job, message) => void reported.push([job, message]),
    );
    await calls[0]?.task();
    expect(reported).toEqual([["boom", "bad state"]]);

    const failing = fakeCron();
    const logger2 = recordingLogger();
    scheduleJobs(
      failing.cron,
      [{ name: "boom", cron: "* * * * *", run: () => Promise.reject(new Error("bad state")) }],
      logger2.log,
      () => Promise.reject(new Error("alerting down https://hooks.example/SECRET")),
    );
    await failing.calls[0]?.task();
    expect(logger2.lines.map((l) => l.event)).toEqual(["job_crashed", "job_crash_report_failed"]);
    expect(JSON.stringify(logger2.lines)).not.toContain("SECRET");
  });

  it("runs the job body when the cron fires", async () => {
    const { cron, calls } = fakeCron();
    let ran = 0;
    scheduleJobs(
      cron,
      [{ name: "j", cron: "* * * * *", run: () => Promise.resolve(void (ran += 1)) }],
      recordingLogger().log,
    );
    await calls[0]?.task();
    expect(ran).toBe(1);
  });
});

describe("node-cron integration", () => {
  it("accepts both job expressions and the America/New_York timezone", () => {
    expect(nodeCron.validate(MORNING_CRON)).toBe(true);
    expect(nodeCron.validate(SETTLEMENT_CRON)).toBe(true);
    const handle = defaultCron.schedule(MORNING_CRON, () => undefined, {
      timezone: "America/New_York",
      name: "test-morning",
      noOverlap: true,
    });
    expect(typeof handle.stop).toBe("function");
    handle.stop();
  });
});
