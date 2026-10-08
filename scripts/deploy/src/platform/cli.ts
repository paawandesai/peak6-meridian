import { deployRailway, planRailway, type RailwayRun } from "./railway";
import type { PlatformDeps } from "./platform";
import { deployVercel, planVercel, type VercelRun } from "./vercel";

export type CliDeps = PlatformDeps & {
  readonly repoRoot: string;
  readonly run: VercelRun & RailwayRun;
};

const USAGE = "usage: deploy-platform <vercel|railway> [--dry-run]\n";

/** Returns the process exit code. `--dry-run` prints the plan (variable names only), no network. */
export async function runPlatformCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: CliDeps,
): Promise<number> {
  const [target, ...flags] = argv;
  const dryRun = flags.includes("--dry-run");
  if ((target !== "vercel" && target !== "railway") || flags.some((flag) => flag !== "--dry-run")) {
    deps.log(USAGE.trimEnd());
    return 2;
  }
  const projectName = env.DEPLOY_PROJECT_NAME ?? "meridian";
  if (target === "vercel") {
    const options = {
      token: env.VERCEL_TOKEN ?? "",
      projectName: env.VERCEL_PROJECT_NAME ?? projectName,
      ...(env.VERCEL_TEAM_ID === undefined || env.VERCEL_TEAM_ID === ""
        ? {}
        : { teamId: env.VERCEL_TEAM_ID }),
      env,
      repoRoot: deps.repoRoot,
    };
    if (dryRun) return report("vercel", planVercel(options), options.token, deps);
    if (options.token === "") return fail("VERCEL_TOKEN is not set", deps);
    const result = await deployVercel(deps, options, deps.run);
    deps.log(`app URL: ${result.url}`);
    return 0;
  }
  const options = {
    token: env.RAILWAY_TOKEN ?? "",
    projectName: env.RAILWAY_PROJECT_NAME ?? projectName,
    serviceName: env.RAILWAY_SERVICE_NAME ?? "automation",
    env,
    repoRoot: deps.repoRoot,
  };
  if (dryRun) return report("railway", planRailway(options), options.token, deps);
  if (options.token === "") return fail("RAILWAY_TOKEN is not set", deps);
  const result = await deployRailway(deps, options, deps.run);
  deps.log(`automation URL: ${result.url}`);
  return 0;
}

function fail(message: string, deps: CliDeps): number {
  deps.log(`deploy-platform: ${message}`);
  return 1;
}

function report(
  name: string,
  collected: ReturnType<typeof planVercel>,
  token: string,
  deps: CliDeps,
): number {
  deps.log(`${name} dry run (names only):`);
  deps.log(`  token: ${token === "" ? "MISSING" : "present"}`);
  deps.log(`  will set: ${Object.keys(collected.values).join(", ") || "(none)"}`);
  deps.log(`  missing required: ${collected.missingRequired.join(", ") || "(none)"}`);
  deps.log(`  missing optional: ${collected.missingOptional.join(", ") || "(none)"}`);
  return collected.missingRequired.length > 0 || token === "" ? 1 : 0;
}
