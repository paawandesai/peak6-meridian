import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { parseOptions } from "./options";

const key = () => Keypair.generate().publicKey.toBase58();
const env = () => ({
  SOLANA_RPC_URL: "http://127.0.0.1:8899",
  ADMIN_KEYPAIR_PATH: "/keys/admin.json",
  PROGRAM_KEYPAIR_PATH: "keys/program.json",
  FAUCET_PUBKEY: key(),
  AUTOMATION_PUBKEY: key(),
});

describe("parseOptions", () => {
  it("parses the required environment and defaults the output path", () => {
    const options = parseOptions(env(), [], "/repo");
    if (options === "help") throw new Error("unexpected help");
    expect(options.rpcUrl).toBe("http://127.0.0.1:8899");
    expect(options.outPath).toBe("/repo/deployments/devnet.json");
    expect(options.programKeypairPath).toBe("/repo/keys/program.json");
    expect(options.adminKeypairPath).toBe("/keys/admin.json");
    expect(options.skipBuild).toBe(false);
    expect(options.feedsPath).toBeUndefined();
  });

  it("reads flags and resolves relative paths against the repo root", () => {
    const queue = key();
    const options = parseOptions(
      { ...env(), SOLANA_CLUSTER: "localnet" },
      ["--out", "tmp/rec.json", "--feeds", "/abs/feeds.json", "--queue", queue, "--skip-build"],
      "/repo",
    );
    if (options === "help") throw new Error("unexpected help");
    expect(options.outPath).toBe("/repo/tmp/rec.json");
    expect(options.feedsPath).toBe("/abs/feeds.json");
    expect(options.queue?.toBase58()).toBe(queue);
    expect(options.solanaCluster).toBe("localnet");
    expect(options.skipBuild).toBe(true);
  });

  it("--repo-root redirects relative paths to the given root", () => {
    const options = parseOptions(env(), ["--repo-root", "/copy", "--out", "rec.json"], "/repo");
    if (options === "help") throw new Error("unexpected help");
    expect(options.repoRoot).toBe("/copy");
    expect(options.outPath).toBe("/copy/rec.json");
    expect(options.programKeypairPath).toBe("/copy/keys/program.json");
  });

  it("takes the queue from SWITCHBOARD_QUEUE when --queue is absent", () => {
    const queue = key();
    const options = parseOptions({ ...env(), SWITCHBOARD_QUEUE: queue }, [], "/repo");
    if (options === "help") throw new Error("unexpected help");
    expect(options.queue?.toBase58()).toBe(queue);
  });

  it("returns help", () => {
    expect(parseOptions({}, ["--help"], "/repo")).toBe("help");
  });

  it("lists every missing or invalid variable", () => {
    expect(() => parseOptions({}, [], "/repo")).toThrow(/SOLANA_RPC_URL.*FAUCET_PUBKEY/s);
    expect(() => parseOptions({ ...env(), FAUCET_PUBKEY: "nope" }, [], "/repo")).toThrow(
      /FAUCET_PUBKEY/,
    );
    expect(() => parseOptions(env(), ["--queue", "nope"], "/repo")).toThrow(/--queue/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseOptions(env(), ["--mainnet"], "/repo")).toThrow();
  });

  it("never reads FAUCET_KEYPAIR or AUTOMATION_KEYPAIR", () => {
    const options = parseOptions(
      { ...env(), FAUCET_KEYPAIR: "[1,2,3]", AUTOMATION_KEYPAIR: "[4,5,6]" },
      [],
      "/repo",
    );
    expect(JSON.stringify(options)).not.toContain("[1,2,3]");
  });
});
