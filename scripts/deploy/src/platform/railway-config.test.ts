import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONFIG_FILE } from "./railway";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const config = JSON.parse(readFileSync(`${root}${CONFIG_FILE}`, "utf8")) as {
  build: { buildCommand: string };
  deploy: { startCommand: string };
};

describe("services/automation/railway.json", () => {
  it("installs only automation and its workspace dependencies, from the lockfile", () => {
    expect(config.build.buildCommand).toContain("pnpm install --frozen-lockfile");
    expect(config.build.buildCommand).toContain("--filter automation...");
  });

  it("starts the automation service", () => {
    expect(config.deploy.startCommand).toBe("cd services/automation && ./node_modules/.bin/tsx src/main.ts");
  });
});
