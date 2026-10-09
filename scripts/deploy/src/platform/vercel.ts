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
): Promise<{ readonly id: string; readonly orgId: string; readonly created: boolean }> {
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
  const found = await call("vercel GET project", `/v9/projects/${name}${q("?")}`, {
    method: "GET",
  });
  if (found.status === 200) {
    const id = asRecord(found.body).id;
    if (typeof id !== "string") throw new Error("vercel: project response has no id");
    return { id, orgId, created: false };
  }
  if (found.status !== 404) {
    throw new Error(`vercel: looking up project failed (status ${found.status})`);
  }
  const created = await call("vercel POST project", `/v11/projects${q("?")}`, {
    method: "POST",
    body: JSON.stringify({
      name: options.projectName,
      framework: "nextjs",
      rootDirectory: "app",
      nodeVersion: "22.x",
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
  await upsertVercelEnv(deps, options, project.id, collected, secrets);

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
  return { url };
}
