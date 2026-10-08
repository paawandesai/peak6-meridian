import { describe, expect, it } from "vitest";

import { runRehearsal } from "./rehearsal";

describe("runRehearsal error redaction", () => {
  const argv = ["--cluster", "devnet", "--phase", "trade"];

  it("never echoes the RPC URL, even when setup fails before connecting", async () => {
    for (const rpcUrl of [
      "http://127.0.0.1:9/?api-key=SECRET123", // unreachable: the cluster guard fails closed
      "SECRET123 not a url", // fails env parsing
    ]) {
      let message = "";
      try {
        await runRehearsal(argv, {
          SOLANA_CLUSTER: "devnet",
          SOLANA_RPC_URL: rpcUrl,
          ADMIN_KEYPAIR_PATH: "/nonexistent",
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("SECRET123");
    }
  });

  it("refuses a missing cluster before touching the network", async () => {
    await expect(runRehearsal(argv, { SOLANA_RPC_URL: "http://127.0.0.1:9" })).rejects.toThrow();
  });
});
