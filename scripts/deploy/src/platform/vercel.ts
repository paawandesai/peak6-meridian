/**
 * Vercel deploy (M2-11): finds or creates the project BY NAME through the REST API (no
 * VERCEL_ORG_ID / VERCEL_PROJECT_ID needed), upserts its production env, then deploys with the
 * Vercel CLI, which reads the token and IDs from its environment (never argv).
 */
import {
  assertComplete,
  childEnv,
  VERCEL_CLI_VERSION,
  collectEnv,
  APP_ENV,
  isPublicName,
  requestJson,
  redactSecrets,
  secretValues,
  type CollectedEnv,
  type PlatformDeps,
} from "./platform";

const API = "https://api.vercel.com";

export type VercelOptions = {
  readonly token: string;
  readonly projectName: string;
  /** Team slug/ID; absent for a personal (Hobby) account. */
  readonly teamId?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
};

export type VercelRun = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => Promise<{ readonly stdout: string }>;

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json =>
  typeof value === "object" && value !== null ? (value as Json) : {};

export function planVercel(options: VercelOptions): CollectedEnv {
  return collectEnv(APP_ENV, options.env);
}

export async function ensureVercelProject(
  deps: PlatformDeps,
  options: VercelOptions,
  secrets: readonly string[],
): Promise<{
  readonly id: string;
  readonly orgId: string;
  readonly created: boolean;
  readonly teamId?: string;
}> {
  const headers = { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" };
  const scope = options.teamId === undefined ? "" : `teamId=${encodeURIComponent(options.teamId)}`;
  const q = (prefix: string): string => (scope === "" ? "" : `${prefix}${scope}`);
  const call = (label: string, path: string, init: RequestInit) =>
    requestJson(deps, label, `${API}${path}`, { ...init, headers }, secrets);

  let orgId = options.teamId;
  if (orgId === undefined) {
    const me = await call("vercel GET /v2/user", "/v2/user", { method: "GET" });
    const id = asRecord(asRecord(me.body).user).id;
    if (me.status !== 200 || typeof id !== "string") {
      throw new Error(`vercel: cannot identify the account (status ${me.status})`);
    }
    orgId = id;
  }

  const name = encodeURIComponent(options.projectName);
  const lookup = async (teamScope: string) =>
    call("vercel GET project", `/v9/projects/${name}${teamScope === "" ? "" : `?${teamScope}`}`, {
      method: "GET",
    });
  const found = await lookup(scope);
  if (found.status === 200) {
    const id = asRecord(found.body).id;
    if (typeof id !== "string") throw new Error("vercel: project response has no id");
    return { id, orgId, created: false };
  }
  if (found.status !== 404) {
    throw new Error(`vercel: looking up project failed (status ${found.status})`);
  }
  if (options.teamId === undefined) {
    // The live project may sit under a team the token can see (VERCEL_TEAM_ID unset): reuse it
    // rather than create a duplicate in the personal scope.
    const teams = await call("vercel GET /v2/teams", "/v2/teams", { method: "GET" });
    const list = asRecord(teams.body).teams;
    for (const team of Array.isArray(list) ? list : []) {
      const teamId = asRecord(team).id;
      if (typeof teamId !== "string") continue;
      const inTeam = await lookup(`teamId=${encodeURIComponent(teamId)}`);
      const id = asRecord(inTeam.body).id;
      if (inTeam.status === 200 && typeof id === "string") {
        deps.log(`vercel: reusing project ${options.projectName} in team ${teamId}`);
        return { id, orgId: teamId, created: false, teamId };
      }
    }
  }
  const created = await call("vercel POST project", `/v11/projects${q("?")}`, {
    method: "POST",
    body: JSON.stringify({
      name: options.projectName,
      framework: "nextjs",
      rootDirectory: "app",
    }),
  });
  const id = asRecord(created.body).id;
  if (created.status >= 300 || typeof id !== "string") {
    const err = asRecord(asRecord(created.body).error);
    const code = typeof err.code === "string" ? `, ${err.code}` : "";
    const message = typeof err.message === "string" ? `: ${err.message}` : "";
    throw new Error(
      redactSecrets(
        `vercel: creating project ${options.projectName} failed (status ${created.status}${code})${message}`,
        secrets,
      ),
    );
  }
  deps.log(`vercel: created project ${options.projectName}`);
  return { id, orgId, created: true };
}

export async function upsertVercelEnv(
  deps: PlatformDeps,
  options: VercelOptions,
  projectId: string,
  collected: CollectedEnv,
  secrets: readonly string[],
): Promise<void> {
  const body = Object.entries(collected.values).map(([key, value]) => ({
    key,
    value,
    type: isPublicName(key) ? "plain" : "encrypted",
    target: ["production"],
  }));
  const scope = options.teamId === undefined ? "" : `&teamId=${encodeURIComponent(options.teamId)}`;
  const result = await requestJson(
    deps,
    "vercel POST env",
    `${API}/v10/projects/${projectId}/env?upsert=true${scope}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    secrets,
  );
  if (result.status >= 300) {
    throw new Error(`vercel: setting env failed (status ${result.status})`);
  }
  deps.log(`vercel: set ${body.length} env vars: ${body.map((entry) => entry.key).join(", ")}`);
}

/** The production URL: the last `https://` token the CLI printed on stdout. */
export function parseDeploymentUrl(stdout: string): string {
  const urls = stdout.match(/https:\/\/[^\s]+/g);
  const last = urls?.[urls.length - 1];
  if (last === undefined) throw new Error("vercel: the CLI printed no deployment URL");
  return last;
}

export async function deployVercel(
  deps: PlatformDeps,
  options: VercelOptions,
  run: VercelRun,
): Promise<{ readonly url: string }> {
  const collected = planVercel(options);
  assertComplete("vercel", collected);
  const secrets = secretValues([options.token], collected);
  const project = await ensureVercelProject(deps, options, secrets);
  const scoped = project.teamId === undefined ? options : { ...options, teamId: project.teamId };
  await upsertVercelEnv(deps, scoped, project.id, collected, secrets);

  const env = childEnv({
    VERCEL_TOKEN: options.token,
    VERCEL_ORG_ID: project.orgId,
    VERCEL_PROJECT_ID: project.id,
  });
  let stdout: string;
  try {
    ({ stdout } = await run(
      "npx",
      ["--yes", `vercel@${VERCEL_CLI_VERSION}`, "deploy", "--prod", "--yes"],
      { cwd: options.repoRoot, env },
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, secrets));
  }
  const url = parseDeploymentUrl(stdout);
  deps.log(`vercel: deployed ${url}`);
  const alias = options.env.VERCEL_PRODUCTION_ALIAS ?? "peak6-meridian.vercel.app";
  if (alias !== "") await assignAlias(deps, scoped, url, alias, secrets);
  return { url };
}

/** Points the public alias at this deployment; a failure is logged (with Vercel's code), not fatal. */
async function assignAlias(
  deps: PlatformDeps,
  options: VercelOptions,
  url: string,
  alias: string,
  secrets: readonly string[],
): Promise<void> {
  const host = encodeURIComponent(new URL(url).host);
  const scope = options.teamId === undefined ? "" : `?teamId=${encodeURIComponent(options.teamId)}`;
  const result = await requestJson(
    deps,
    "vercel POST alias",
    `${API}/v2/deployments/${host}/aliases${scope}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ alias }),
    },
    secrets,
  );
  if (result.status < 300) {
    deps.log(`vercel: aliased https://${alias} -> ${url}`);
    return;
  }
  const err = asRecord(asRecord(result.body).error);
  const code = typeof err.code === "string" ? `, ${err.code}` : "";
  const message = typeof err.message === "string" ? `: ${err.message}` : "";
  deps.log(
    redactSecrets(
      `vercel: WARNING could not alias ${alias} (status ${result.status}${code})${message}`,
      secrets,
    ),
  );
}
