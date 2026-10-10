import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  flag,
  isTruthy,
  parseDemoEnv,
  readOptional,
  REPO_ROOT,
  resolvePath,
  rpcUrlOf,
  writeText,
} from "./env";

describe("parseDemoEnv / rpcUrlOf", () => {
  it("prefers MERIDIAN_DEVNET_RPC_URL over SOLANA_RPC_URL and treats blanks as unset", () => {
    const both = parseDemoEnv({
      MERIDIAN_DEVNET_RPC_URL: "https://devnet.example.com/?key=s3cret",
      SOLANA_RPC_URL: "http://127.0.0.1:8899",
    });
    expect(rpcUrlOf(both)).toBe("https://devnet.example.com/?key=s3cret");
    expect(
      rpcUrlOf(
        parseDemoEnv({ MERIDIAN_DEVNET_RPC_URL: " ", SOLANA_RPC_URL: "http://127.0.0.1:8899" }),
      ),
    ).toBe("http://127.0.0.1:8899");
    expect(rpcUrlOf(parseDemoEnv({}))).toBeUndefined();
  });

  it("names a bad variable without echoing its value", () => {
    let message = "";
    try {
      parseDemoEnv({ MERIDIAN_DEVNET_RPC_URL: "not a url s3cret" });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("invalid environment: MERIDIAN_DEVNET_RPC_URL");
  });
});

describe("paths and flags", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("expands ~ and resolves relative paths against the repo root", () => {
    expect(resolvePath("~/k.json", "/home/op")).toBe("/home/op/k.json");
    expect(resolvePath("/abs/x.json")).toBe("/abs/x.json");
    expect(resolvePath("deployments/demo-sessions.json")).toBe(
      resolve(REPO_ROOT, "deployments/demo-sessions.json"),
    );
  });

  it("reads optional files and writes through missing directories", () => {
    dir = mkdtempSync(join(tmpdir(), "demo-env-"));
    const path = join(dir, "a", "b.json");
    expect(readOptional(path)).toBeNull();
    writeText(path, "{}\n");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(readOptional(path)).toBe("{}\n");
  });

  it("treats empty make variables as absent and parses DRY_RUN", () => {
    expect(flag(undefined)).toBeUndefined();
    expect(flag("  ")).toBeUndefined();
    expect(flag(" x ")).toBe("x");
    for (const yes of ["1", "true", "YES", "y"]) expect(isTruthy(yes)).toBe(true);
    for (const no of [undefined, "", "0", "false", "no"]) expect(isTruthy(no)).toBe(false);
  });
});
