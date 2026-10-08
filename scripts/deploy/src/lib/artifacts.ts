import { createHash } from "node:crypto";

/** sha256 of `bytes`, hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Throws when the IDL of the build lists `local_oracle_set` (AB-22). This is the one place a
 * local-oracle `.so` could reach devnet, so it runs before the first transaction: a stale
 * local-oracle build left by `make test`, `make e2e` or `make client` must be rejected.
 */
export function assertNoLocalOracle(idlJson: string): void {
  const parsed: unknown = JSON.parse(idlJson);
  const instructions =
    typeof parsed === "object" && parsed !== null && "instructions" in parsed
      ? parsed.instructions
      : null;
  if (!Array.isArray(instructions)) {
    throw new Error("the IDL has no instructions list; is this a Meridian build?");
  }
  const names = instructions.map((entry: unknown) =>
    typeof entry === "object" && entry !== null && "name" in entry ? String(entry.name) : "",
  );
  if (!names.includes("settle_market")) {
    throw new Error("the IDL does not look like Meridian's (no settle_market); refusing to deploy");
  }
  if (names.includes("local_oracle_set")) {
    throw new Error(
      "target/idl/meridian.json lists local_oracle_set: this is a local-oracle build " +
        "(make test / make e2e / make client), not a devnet build. Nothing was sent. " +
        "Run without --skip-build, or `make build-devnet`.",
    );
  }
}
