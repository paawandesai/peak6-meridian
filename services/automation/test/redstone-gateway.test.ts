/**
 * RedStone gateway tests (M2-16 AC1)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchRedstonePackages } from "../src/redstone/gateway.js";
import type { RedstoneGatewayConfig } from "../src/redstone/types.js";

describe("RedStone gateway client", () => {
  const mockConfig: RedstoneGatewayConfig = {
    gateways: ["https://gateway1.example", "https://gateway2.example"],
    dataServiceId: "redstone-primary-prod",
    maxPackageDelaySecs: 600,
    requiredSigners: 3,
    timeoutMs: 5000,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requires at least 2 gateways", async () => {
    const singleGatewayConfig = { ...mockConfig, gateways: ["https://gateway1.example"] };

    await expect(
      fetchRedstonePackages(singleGatewayConfig, "AAPL", Date.now()),
    ).rejects.toThrow("RedStone requires at least 2 gateways");
  });

  it("fetches from >=2 gateways and validates byte-identical responses", async () => {
    const mockPayload = "0x1234567890abcdef";
    const mockResponse = {
      id: "AAPL",
      timestampMilliseconds: 1700000000000,
      payload: mockPayload,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mockResponse],
    });

    const result = await fetchRedstonePackages(mockConfig, "AAPL", 1700000000000);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("fails when only one gateway responds", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            id: "AAPL",
            timestampMilliseconds: 1700000000000,
            payload: "0x1234",
          }],
        });
      }
      return Promise.reject(new Error("Gateway timeout"));
    });

    await expect(
      fetchRedstonePackages(mockConfig, "AAPL", 1700000000000),
    ).rejects.toThrow(/Only 1\/2 gateway\(s\) responded/);
  });

  it("fails when gateway payloads differ", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: async () => [{
          id: "AAPL",
          timestampMilliseconds: 1700000000000,
          payload: callCount === 1 ? "0x1234" : "0x5678", // Different payloads
        }],
      });
    });

    await expect(
      fetchRedstonePackages(mockConfig, "AAPL", 1700000000000),
    ).rejects.toThrow(/Gateway payload mismatch/);
  });

  it("fails when gateway timestamps differ", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: async () => [{
          id: "AAPL",
          timestampMilliseconds: callCount === 1 ? 1700000000000 : 1700000001000, // Different timestamps
          payload: "0x1234",
        }],
      });
    });

    await expect(
      fetchRedstonePackages(mockConfig, "AAPL", 1700000000000),
    ).rejects.toThrow(/Gateway timestamp mismatch/);
  });

  it("handles gateway HTTP errors", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(
      fetchRedstonePackages(mockConfig, "AAPL", 1700000000000),
    ).rejects.toThrow(/Only 0\/2 gateway\(s\) responded/);
  });

  it("handles gateway timeout", async () => {
    global.fetch = vi.fn().mockImplementation(() =>
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), 100)
      )
    );

    await expect(
      fetchRedstonePackages({ ...mockConfig, timeoutMs: 50 }, "AAPL", Date.now()),
    ).rejects.toThrow(/Only 0\/2 gateway\(s\) responded/);
  }, 10000);

  it("converts hex payload to bytes correctly", async () => {
    const mockPayload = "0xaabbccdd";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        id: "AAPL",
        timestampMilliseconds: 1700000000000,
        payload: mockPayload,
      }],
    });

    const result = await fetchRedstonePackages(mockConfig, "AAPL", 1700000000000);

    expect(result).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]));
  });
});
