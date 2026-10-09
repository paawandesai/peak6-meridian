/**
 * RedStone oracle integration (M2-16)
 *
 * Small interface for chain-facing calls to be wired after M2-15 merges
 */

export * from "./types.js";
export * from "./gateway.js";
export * from "./crosscheck.js";

/**
 * Chain interface (to be implemented after M2-15)
 * Placeholder for post_redstone_price call with OracleConfig and RedstonePrice PDAs
 */
export interface RedstoneChainClient {
  postPrice(symbol: string, payload: Uint8Array): Promise<string>; // Returns tx signature
}
