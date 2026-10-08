import { describe, expect, it } from "vitest";

import { assertCluster, DEVNET_GENESIS_HASH } from "./cluster";

const SECRET_URL = "https://devnet.example/?api-key=SECRET123";

describe("assertCluster (interim stand-in for M2-01's shared guard)", () => {
  it("accepts devnet by genesis hash, whatever the hostname", async () => {
    await expect(
      assertCluster({
        cluster: "devnet",
        rpcUrl: SECRET_URL,
        getGenesisHash: () => Promise.resolve(DEVNET_GENESIS_HASH),
      }),
    ).resolves.toBe("devnet");
  });

  it("refuses another cluster behind a devnet-looking URL, without leaking the URL", async () => {
    const result = assertCluster({
      cluster: "devnet",
      rpcUrl: SECRET_URL,
      getGenesisHash: () => Promise.resolve("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"),
    });
    await expect(result).rejects.toThrow(/not devnet/);
    await expect(result).rejects.not.toThrow(/SECRET123/);
  });

  it("refuses an unreachable RPC and never echoes the underlying error or URL", async () => {
    const result = assertCluster({
      cluster: "devnet",
      rpcUrl: SECRET_URL,
      getGenesisHash: () => Promise.reject(new Error(`fetch failed ${SECRET_URL}`)),
    });
    await expect(result).rejects.toThrow(/unreachable/);
    await expect(result).rejects.not.toThrow(/SECRET123/);
  });

  it("accepts localnet only on a loopback URL", async () => {
    const never = () => Promise.reject(new Error("must not be asked"));
    for (const rpcUrl of ["http://127.0.0.1:8899", "http://localhost:8899/", "http://[::1]:8899"]) {
      await expect(
        assertCluster({ cluster: "localnet", rpcUrl, getGenesisHash: never }),
      ).resolves.toBe("localnet");
    }
    for (const rpcUrl of [
      "https://mainnet.example/",
      "http://127.0.0.1.evil.example/",
      SECRET_URL,
    ]) {
      const result = assertCluster({ cluster: "localnet", rpcUrl, getGenesisHash: never });
      await expect(result).rejects.toThrow(/loopback/);
      await expect(result).rejects.not.toThrow(/SECRET123/);
    }
  });

  it("refuses mainnet and anything else by name", async () => {
    for (const cluster of ["mainnet-beta", "mainnet", "testnet", ""]) {
      await expect(
        assertCluster({
          cluster,
          rpcUrl: "http://127.0.0.1:8899",
          getGenesisHash: () => Promise.resolve(DEVNET_GENESIS_HASH),
        }),
      ).rejects.toThrow(/unsupported cluster/);
    }
  });
});
