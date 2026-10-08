/**
 * Railway deploy (M2-11): resolves the project BY NAME (a project token names its own project;
 * an account token lists or creates it), ensures the service, sets its variables, points it at
 * services/automation/railway.json, uploads with the Railway CLI, and checks `/health` with the
 * bearer token. Variable values and tokens never reach logs or errors.
 */
import {
  assertComplete,
  collectEnv,
  AUTOMATION_ENV,
  redactSecrets,
  requestJson,
  secretValues,
  type CollectedEnv,
  type PlatformDeps,
} from "./platform";

const API = "https://backboard.railway.com/graphql/v2";
export const CONFIG_FILE = "services/automation/railway.json";

export type RailwayOptions = {
  readonly token: string;
  readonly projectName: string;
  readonly serviceName: string;
  readonly cliVersion: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
  readonly healthAttempts?: number;
  readonly healthIntervalMs?: number;
};

export type RailwayRun = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => Promise<{ readonly stdout: string }>;

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json =>
  typeof value === "object" && value !== null ? (value as Json) : {};
const edges = (value: unknown): Json[] => {
  const list = asRecord(value).edges;
  return Array.isArray(list) ? list.map((edge) => asRecord(asRecord(edge).node)) : [];
};

export function planRailway(options: RailwayOptions): CollectedEnv {
  return collectEnv(AUTOMATION_ENV, options.env);
}

type Gql = (label: string, query: string, variables: Json) => Promise<Json>;

function makeGql(deps: PlatformDeps, headers: Record<string, string>, secrets: string[]): Gql {
  return async (label, query, variables) => {
    const result = await requestJson(
      deps,
      `railway ${label}`,
      API,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ query, variables }),
      },
      secrets,
    );
    const body = asRecord(result.body);
    if (result.status !== 200 || Array.isArray(body.errors)) {
      throw new Error(`railway: ${label} failed (status ${result.status})`);
    }
    return asRecord(body.data);
  };
}

type Target = {
  readonly projectId: string;
  readonly environmentId: string;
  readonly kind: "project" | "account";
};

async function resolveTarget(
  deps: PlatformDeps,
  options: RailwayOptions,
  secrets: string[],
): Promise<{ readonly target: Target; readonly gql: Gql }> {
  // A project token names its project and environment; no creation is possible with it.
  const projectGql = makeGql(deps, { "Project-Access-Token": options.token }, secrets);
  try {
    const data = await projectGql(
      "projectToken",
      "query { projectToken { projectId environmentId } }",
      {},
    );
    const info = asRecord(data.projectToken);
    if (typeof info.projectId === "string" && typeof info.environmentId === "string") {
      return {
        target: { projectId: info.projectId, environmentId: info.environmentId, kind: "project" },
        gql: projectGql,
      };
    }
  } catch {
    // Not a project token: fall through to the account token path.
  }
  const gql = makeGql(deps, { Authorization: `Bearer ${options.token}` }, secrets);
  const listed = await gql(
    "projects",
    "query { projects { edges { node { id name environments { edges { node { id name } } } } } } }",
    {},
  );
  const existing = edges(listed.projects).find((node) => node.name === options.projectName);
  const project =
    existing ??
    asRecord(
      (
        await gql(
          "projectCreate",
          `mutation($name: String!) { projectCreate(input: { name: $name }) { id name environments { edges { node { id name } } } } }`,
          { name: options.projectName },
        )
      ).projectCreate,
    );
  if (existing === undefined) deps.log(`railway: created project ${options.projectName}`);
  const environments = edges(project.environments);
  const production = environments.find((node) => node.name === "production") ?? environments[0];
  if (typeof project.id !== "string" || typeof production?.id !== "string") {
    throw new Error("railway: project has no usable environment");
  }
  return {
    target: { projectId: project.id, environmentId: production.id, kind: "account" },
    gql,
  };
}

async function ensureService(gql: Gql, target: Target, name: string): Promise<string> {
  const data = await gql(
    "services",
    "query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }",
    { id: target.projectId },
  );
  const found = edges(asRecord(data.project).services).find((node) => node.name === name);
  if (typeof found?.id === "string") return found.id;
  const created = await gql(
    "serviceCreate",
    "mutation($projectId: String!, $name: String!) { serviceCreate(input: { projectId: $projectId, name: $name }) { id } }",
    { projectId: target.projectId, name },
  );
  const id = asRecord(created.serviceCreate).id;
  if (typeof id !== "string") throw new Error("railway: serviceCreate returned no id");
  return id;
}

async function ensureDomain(gql: Gql, target: Target, serviceId: string): Promise<string> {
  const data = await gql(
    "domains",
    `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
       domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { domain } }
     }`,
    { projectId: target.projectId, environmentId: target.environmentId, serviceId },
  );
  const list = asRecord(data.domains).serviceDomains;
  const first = asRecord(Array.isArray(list) ? list[0] : null).domain;
  if (typeof first === "string") return first;
  const created = await gql(
    "serviceDomainCreate",
    "mutation($serviceId: String!, $environmentId: String!) { serviceDomainCreate(input: { serviceId: $serviceId, environmentId: $environmentId }) { domain } }",
    { serviceId, environmentId: target.environmentId },
  );
  const domain = asRecord(created.serviceDomainCreate).domain;
  if (typeof domain !== "string")
    throw new Error("railway: serviceDomainCreate returned no domain");
  return domain;
}

/** GET `/health` with the bearer; a bounded number of attempts, spaced out. */
export async function checkHealth(
  deps: PlatformDeps,
  url: string,
  serviceToken: string,
  attempts: number,
  intervalMs: number,
): Promise<void> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await deps.fetch(`${url}/health`, {
        method: "GET",
        headers: { Authorization: `Bearer ${serviceToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      lastStatus = response.status;
      if (response.status === 200) {
        deps.log(`railway: ${url}/health reachable with bearer (200)`);
        return;
      }
    } catch {
      lastStatus = 0;
    }
    if (attempt < attempts) await deps.sleep(intervalMs);
  }
  throw new Error(
    `railway: ${url}/health not healthy after ${attempts} attempts (last status ${lastStatus})`,
  );
}

export async function deployRailway(
  deps: PlatformDeps,
  options: RailwayOptions,
  run: RailwayRun,
): Promise<{ readonly url: string }> {
  const collected = planRailway(options);
  assertComplete("railway", collected);
  const secrets = secretValues([options.token], collected);
  const { target, gql } = await resolveTarget(deps, options, secrets);
  const serviceId = await ensureService(gql, target, options.serviceName);

  await gql(
    "variableCollectionUpsert",
    `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    {
      input: {
        projectId: target.projectId,
        environmentId: target.environmentId,
        serviceId,
        variables: collected.values,
      },
    },
  );
  deps.log(
    `railway: set ${Object.keys(collected.values).length} variables: ${Object.keys(collected.values).join(", ")}`,
  );
  await gql(
    "serviceInstanceUpdate",
    `mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
       serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
     }`,
    { serviceId, environmentId: target.environmentId, input: { railwayConfigFile: CONFIG_FILE } },
  );
  const domain = await ensureDomain(gql, target, serviceId);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.RAILWAY_TOKEN;
  delete env.RAILWAY_API_TOKEN;
  env[target.kind === "project" ? "RAILWAY_TOKEN" : "RAILWAY_API_TOKEN"] = options.token;
  try {
    await run(
      "npx",
      [
        "--yes",
        `@railway/cli@${options.cliVersion}`,
        "up",
        "--ci",
        "--service",
        options.serviceName,
        "--environment",
        target.environmentId,
      ],
      { cwd: options.repoRoot, env },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, secrets));
  }
  const url = `https://${domain}`;
  await checkHealth(
    deps,
    url,
    collected.values.SERVICE_TOKEN ?? "",
    options.healthAttempts ?? 3,
    options.healthIntervalMs ?? 120_000,
  );
  return { url };
}
