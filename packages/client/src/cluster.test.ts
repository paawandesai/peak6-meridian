import { readFileSync } from "node:fs";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertCluster,
  ClusterError,
  DEVNET_GENESIS_HASH,
  isLoopbackUrl,
  MAINNET_BETA_GENESIS_HASH,
  TESTNET_GENESIS_HASH,
} from "./cluster";

const genesis = (hash: string) => () => Promise.resolve(hash);
const unreachable = () => Promise.reject(new Error("fetch failed"));

describe("assertCluster (genesis hash, not hostname)", () => {
  it("allows a non-standard hostname that serves the devnet genesis hash", async () => {
    await expect(
      assertCluster({
        getGenesisHash: genesis(DEVNET_GENESIS_HASH),
        rpcUrl: "https://my-provider.example.com/devnet-rpc",
        cluster: "devnet",
      }),
    ).resolves.toBe("devnet");
  });

  it("treats an unset SOLANA_CLUSTER as devnet and still checks the genesis hash", async () => {
    await expect(
      assertCluster({ getGenesisHash: genesis(DEVNET_GENESIS_HASH), rpcUrl: "https://x.example" }),
    ).resolves.toBe("devnet");
    await expect(
      assertCluster({
        getGenesisHash: genesis(MAINNET_BETA_GENESIS_HASH),
        rpcUrl: "https://x.example",
      }),
    ).rejects.toThrow(/mainnet-beta/);
  });

  it("refuses the mainnet-beta genesis hash even behind a devnet-looking domain", async () => {
    await expect(
      assertCluster({
        getGenesisHash: genesis(MAINNET_BETA_GENESIS_HASH),
        rpcUrl: "https://api.devnet.solana.com",
        cluster: "devnet",
      }),
    ).rejects.toThrow(/mainnet-beta/);
  });

  it("refuses testnet and unknown genesis hashes", async () => {
    await expect(
      assertCluster({ getGenesisHash: genesis(TESTNET_GENESIS_HASH), rpcUrl: "https://x.example" }),
    ).rejects.toThrow(/testnet/);
    await expect(
      assertCluster({ getGenesisHash: genesis("1".repeat(44)), rpcUrl: "https://x.example" }),
    ).rejects.toThrow(/unknown cluster/);
  });

  it("refuses an unreachable RPC (fail closed)", async () => {
    await expect(
      assertCluster({
        getGenesisHash: unreachable,
        rpcUrl: "https://x.example",
        cluster: "devnet",
      }),
    ).rejects.toThrow(/cannot reach the RPC/);
  });

  it("allows localnet only with SOLANA_CLUSTER=localnet and a loopback URL", async () => {
    await expect(
      assertCluster({
        getGenesisHash: unreachable,
        rpcUrl: "http://127.0.0.1:8899",
        cluster: "localnet",
      }),
    ).resolves.toBe("localnet");
    await expect(
      assertCluster({
        getGenesisHash: unreachable,
        rpcUrl: "https://api.mainnet-beta.solana.com",
        cluster: "localnet",
      }),
    ).rejects.toThrow(ClusterError);
    // A loopback URL without SOLANA_CLUSTER=localnet is still checked by genesis hash.
    await expect(
      assertCluster({
        getGenesisHash: genesis("1".repeat(44)),
        rpcUrl: "http://127.0.0.1:8899",
      }),
    ).rejects.toThrow(/unknown cluster/);
  });

  it("rejects any other SOLANA_CLUSTER value without calling the RPC", async () => {
    await expect(
      assertCluster({
        getGenesisHash: genesis(DEVNET_GENESIS_HASH),
        rpcUrl: "https://x.example",
        cluster: "mainnet-beta",
      }),
    ).rejects.toThrow(/cluster must be "devnet" or "localnet"/);
  });
});

describe("cluster.ts stays free of environment access (it is bundled into the app)", () => {
  const source = readFileSync(new URL("./cluster.ts", import.meta.url), "utf8");

  it("does not read process.env", () => {
    expect(source).not.toMatch(/process\.env/);
  });

  it("names no server environment variable", () => {
    expect(source).not.toMatch(/SOLANA_(CLUSTER|RPC_URL)|KEYPAIR|_PUBKEY/);
  });
});

describe("isLoopbackUrl", () => {
  it.each([
    "http://127.0.0.1:8899",
    "http://127.1.2.3:8899",
    "http://localhost:8899",
    "http://LOCALHOST",
    "http://[::1]:8899",
  ])("%s is loopback", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    "https://api.devnet.solana.com",
    "http://127.0.0.1.evil.example",
    "http://10.0.0.5:8899",
    "http://localhost.evil.example",
    "not a url",
    "",
  ])("%s is not loopback", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });

  it("never treats a public hostname as loopback (property)", () => {
    fc.assert(
      fc.property(fc.domain(), (domain) => {
        fc.pre(domain !== "localhost");
        expect(isLoopbackUrl(`https://${domain}/`)).toBe(false);
      }),
    );
  });
});
