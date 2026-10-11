/**
 * Test doubles for the automation service (fake data-API HTTP, clock, chain, alerter, logs).
 * Imported as `automation/testing` by tests only; deliberately not part of the package's main
 * export, so nothing here ships in the production surface.
 */
export * from "./fakeHttp";
export * from "./harness";
export * from "./settleHarness";
export * from "./updateFixture";
export * from "./pythUpdates";
