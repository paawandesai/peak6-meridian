export * from "./alerts";
export * from "./calendar";
export * from "./cli/createMarkets";
export * from "./config";
export * from "./jobs/morning";
export * from "./jobs/settle";
export * from "./log";
export * from "./money";
export * from "./prevCloses";
export * from "./scheduler";
export * from "./server";
export * from "./service";
export * from "./state";
export * from "./strikes";
export * from "./testing/fakeHttp";

/** Health report of the automation service. */
export interface Health {
  readonly service: "automation";
  readonly status: "ok";
}

/**
 * Liveness of the automation service.
 *
 * M1-01 placeholder: last-run details (architecture.md, `GET /health`) arrive with M1-08.
 */
export function health(): Health {
  return { service: "automation", status: "ok" };
}
