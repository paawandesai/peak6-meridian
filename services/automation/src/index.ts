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
