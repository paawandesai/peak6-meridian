import { redactRpcUrl } from "@meridian/client";
import { describe, expect, it } from "vitest";

import { runCommand } from "./process";

describe("runCommand", () => {
  it("returns stdout and stderr on success", async () => {
    const result = await runCommand("node", ["-e", "console.log('out'); console.error('err')"], {
      cwd: process.cwd(),
    });
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("names the command and exit status, and redacts the RPC URL from CLI output", async () => {
    const url = "https://devnet.example/?api-key=SECRET123";
    let message = "";
    try {
      await runCommand(
        "node",
        ["-e", `console.error('RPC error talking to ${url}'); process.exit(3)`],
        { cwd: process.cwd(), redact: (text) => redactRpcUrl(text, url) },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/node -e failed \(exit 3\)/);
    expect(message).toContain("RPC error talking to");
    expect(message).not.toContain("SECRET123");
    expect(message).not.toContain("devnet.example");
  });
});
