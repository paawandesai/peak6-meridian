/**
 * M3-07 AC2: FAULT_INJECT_SOURCE is refused on any non-local cluster (AB-style test).
 *
 * Verifies that:
 * 1. demo-ops.ts calls assertCluster when fault injection is enabled
 * 2. assertCluster rejects non-local clusters (mainnet/testnet/unknown by genesis, non-loopback URLs)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  validateFaultInjection,
  applyFaultOffset,
  FAULT_INJECT_BPS,
} from "../../../scripts/lib/demo/fault-inject";
import {
  assertCluster,
  ClusterError,
  DEVNET_GENESIS_HASH,
  MAINNET_BETA_GENESIS_HASH,
  TESTNET_GENESIS_HASH,
  isLoopbackUrl,
} from "../../../packages/client/src/cluster";

const DEMO_OPS_PATH = join(__dirname, "../../../scripts/demo-ops.ts");

describe("fault injection validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("allows fault injection with valid source tiingo", () => {
    process.env.FAULT_INJECT_SOURCE = "tiingo";

    const config = validateFaultInjection();

    expect(config.source).toBe("tiingo");
    expect(config.offsetBps).toBe(FAULT_INJECT_BPS);
  });

  it("allows fault injection with valid source twelvedata", () => {
    process.env.FAULT_INJECT_SOURCE = "twelvedata";

    const config = validateFaultInjection();

    expect(config.source).toBe("twelvedata");
    expect(config.offsetBps).toBe(FAULT_INJECT_BPS);
  });

  it("allows no fault injection when FAULT_INJECT_SOURCE is unset", () => {
    delete process.env.FAULT_INJECT_SOURCE;

    const config = validateFaultInjection();

    expect(config.source).toBeUndefined();
    expect(config.offsetBps).toBe(FAULT_INJECT_BPS);
  });

  it("refuses invalid fault source values", () => {
    process.env.FAULT_INJECT_SOURCE = "invalid-source";

    expect(() => validateFaultInjection()).toThrow(/must be 'tiingo' or 'twelvedata'/);
  });

  it("refuses empty string as fault source", () => {
    process.env.FAULT_INJECT_SOURCE = "";

    expect(() => validateFaultInjection()).toThrow(/must be 'tiingo' or 'twelvedata'/);
  });

  it("refuses arbitrary source names", () => {
    process.env.FAULT_INJECT_SOURCE = "finnhub";

    expect(() => validateFaultInjection()).toThrow(/must be 'tiingo' or 'twelvedata'/);
  });

  describe("price offset calculation", () => {
    it("applies positive offset correctly", () => {
      const price = 70000n; // $700.00
      const offset = 200; // 2%
      const result = applyFaultOffset(price, offset);

      expect(result).toBe(71400n); // $714.00 (+2%)
    });

    it("applies negative offset correctly", () => {
      const price = 70000n;
      const offset = -200; // -2%
      const result = applyFaultOffset(price, offset);

      expect(result).toBe(68600n); // $686.00 (-2%)
    });

    it("handles zero offset", () => {
      const price = 70000n;
      const result = applyFaultOffset(price, 0);

      expect(result).toBe(70000n);
    });

    it("rounds down for fractional results", () => {
      const price = 99n; // Will produce fractional offset
      const offset = 33; // 0.33%
      const result = applyFaultOffset(price, offset);

      // 99 * 33 / 10000 = 0.3267, rounds down to 0
      expect(result).toBe(99n);
    });

    it("handles large prices", () => {
      const price = 100000n; // $1000.00
      const offset = 200; // 2%
      const result = applyFaultOffset(price, offset);

      expect(result).toBe(102000n); // $1020.00 (+2%)
    });
  });
});

describe("AC2: cluster rejection when fault injection is enabled", () => {
  it("demo-ops.ts calls assertCluster when FAULT_INJECT_SOURCE is set", () => {
    const demoOpsSource = readFileSync(DEMO_OPS_PATH, "utf-8");

    // Verify the source calls assertCluster when fault config has a source
    expect(demoOpsSource).toContain("assertCluster");
    expect(demoOpsSource).toContain("if (faultConfig.source !== undefined)");
    // The guard should check cluster: "localnet" because fault injection is local-only
    expect(demoOpsSource).toContain('cluster: "localnet"');
  });

  it("rejects mainnet genesis hash", async () => {
    await expect(
      assertCluster({
        cluster: "devnet",
        rpcUrl: "https://api.mainnet-beta.solana.com",
        getGenesisHash: async () => MAINNET_BETA_GENESIS_HASH,
      }),
    ).rejects.toThrow(ClusterError);
    await expect(
      assertCluster({
        cluster: "devnet",
        rpcUrl: "https://api.mainnet-beta.solana.com",
        getGenesisHash: async () => MAINNET_BETA_GENESIS_HASH,
      }),
    ).rejects.toThrow(/mainnet-beta/);
  });

  it("rejects testnet genesis hash", async () => {
    await expect(
      assertCluster({
        cluster: "devnet",
        rpcUrl: "https://api.testnet.solana.com",
        getGenesisHash: async () => TESTNET_GENESIS_HASH,
      }),
    ).rejects.toThrow(ClusterError);
    await expect(
      assertCluster({
        cluster: "devnet",
        rpcUrl: "https://api.testnet.solana.com",
        getGenesisHash: async () => TESTNET_GENESIS_HASH,
      }),
    ).rejects.toThrow(/testnet/);
  });

  it("rejects unknown genesis hash", async () => {
    const unknownGenesis = "UnknownGenesisHashForTestingPurposesOnly1234567890";
    await expect(
      assertCluster({
        cluster: "devnet",
        rpcUrl: "https://unknown-rpc.example.com",
        getGenesisHash: async () => unknownGenesis,
      }),
    ).rejects.toThrow(ClusterError);
    await expect(
      assertCluster({
        cluster: "devnet",
        rpcUrl: "https://unknown-rpc.example.com",
        getGenesisHash: async () => unknownGenesis,
      }),
    ).rejects.toThrow(/unknown cluster/);
  });

  it("rejects localnet with non-loopback URL", async () => {
    await expect(
      assertCluster({
        cluster: "localnet",
        rpcUrl: "https://api.devnet.solana.com",
        getGenesisHash: async () => DEVNET_GENESIS_HASH,
      }),
    ).rejects.toThrow(ClusterError);
    await expect(
      assertCluster({
        cluster: "localnet",
        rpcUrl: "https://api.devnet.solana.com",
        getGenesisHash: async () => DEVNET_GENESIS_HASH,
      }),
    ).rejects.toThrow(/loopback/);
  });

  it("rejects unreachable RPC (fail closed)", async () => {
    await expect(
      assertCluster({
        cluster: "devnet",
        rpcUrl: "https://unreachable.example.com",
        getGenesisHash: async () => {
          throw new Error("Network timeout");
        },
      }),
    ).rejects.toThrow(ClusterError);
    await expect(
      assertCluster({
        cluster: "devnet",
        rpcUrl: "https://unreachable.example.com",
        getGenesisHash: async () => {
          throw new Error("Network timeout");
        },
      }),
    ).rejects.toThrow(/cannot reach the RPC/);
  });

  it("accepts devnet genesis hash", async () => {
    const result = await assertCluster({
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      getGenesisHash: async () => DEVNET_GENESIS_HASH,
    });
    expect(result).toBe("devnet");
  });

  it("accepts localnet with loopback URL", async () => {
    const loopbackUrls = [
      "http://127.0.0.1:8899",
      "http://localhost:8899",
      "http://[::1]:8899",
    ];

    for (const url of loopbackUrls) {
      const result = await assertCluster({
        cluster: "localnet",
        rpcUrl: url,
        getGenesisHash: async () => "local-test-genesis", // localnet doesn't check genesis
      });
      expect(result).toBe("localnet");
    }
  });

  describe("loopback URL detection", () => {
    it("recognizes localhost", () => {
      expect(isLoopbackUrl("http://localhost:8899")).toBe(true);
      expect(isLoopbackUrl("https://LOCALHOST:8899")).toBe(true);
    });

    it("recognizes 127.0.0.0/8", () => {
      expect(isLoopbackUrl("http://127.0.0.1:8899")).toBe(true);
      expect(isLoopbackUrl("http://127.1.2.3:8899")).toBe(true);
      expect(isLoopbackUrl("http://127.255.255.254:8899")).toBe(true);
    });

    it("recognizes IPv6 ::1", () => {
      expect(isLoopbackUrl("http://[::1]:8899")).toBe(true);
    });

    it("rejects non-loopback hostnames", () => {
      expect(isLoopbackUrl("https://api.devnet.solana.com")).toBe(false);
      expect(isLoopbackUrl("https://example.com")).toBe(false);
    });

    it("rejects non-loopback IPs", () => {
      expect(isLoopbackUrl("http://192.168.1.1:8899")).toBe(false);
      expect(isLoopbackUrl("http://10.0.0.1:8899")).toBe(false);
      expect(isLoopbackUrl("http://126.0.0.1:8899")).toBe(false);
      expect(isLoopbackUrl("http://128.0.0.1:8899")).toBe(false);
    });
  });
});
