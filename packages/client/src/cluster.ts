/**
 * Cluster guard shared by `scripts/` and the app: a deploy or faucet must only ever run against
 * Solana devnet or a loopback test validator, decided by the cluster's genesis hash and never by
 * the RPC hostname (a provider's devnet URL has an arbitrary name; a mainnet URL can sit behind
 * a custom domain).
 */

/** Genesis hash of Solana devnet. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Genesis hash of Solana mainnet-beta (named only to refuse it with a clear message). */
export const MAINNET_BETA_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** Genesis hash of Solana testnet (named only to refuse it with a clear message). */
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NYwq";

/** The clusters Meridian may be deployed to. */
export type ClusterName = "devnet" | "localnet";

/** Thrown when the RPC is not a cluster Meridian may deploy to. */
export class ClusterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterError";
  }
}

/** The part of a web3.js `Connection` the guard needs. */
export type GenesisSource = { getGenesisHash(): Promise<string> };

/** True when `url` points at this machine (127.0.0.0/8, `localhost` or `::1`). */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

function describeGenesis(genesis: string): string {
  if (genesis === MAINNET_BETA_GENESIS_HASH) {
    return "mainnet-beta";
  }
  if (genesis === TESTNET_GENESIS_HASH) {
    return "testnet";
  }
  return `an unknown cluster (genesis ${genesis})`;
}

/**
 * Returns the cluster the RPC serves or throws `ClusterError`.
 *
 * - `solanaCluster === "localnet"` is allowed only with a loopback `rpcUrl`.
 * - Otherwise the RPC's `getGenesisHash()` must equal [`DEVNET_GENESIS_HASH`]. An unreachable RPC
 *   is refused (fail closed), and so is every other genesis hash, whatever the hostname.
 */
export async function assertCluster(params: {
  readonly connection: GenesisSource;
  readonly rpcUrl: string;
  readonly solanaCluster?: string | undefined;
}): Promise<ClusterName> {
  const { connection, rpcUrl, solanaCluster } = params;
  if (solanaCluster === "localnet") {
    if (!isLoopbackUrl(rpcUrl)) {
      throw new ClusterError(
        "SOLANA_CLUSTER=localnet requires a loopback RPC URL (127.0.0.1, localhost or ::1)",
      );
    }
    return "localnet";
  }
  if (solanaCluster !== undefined && solanaCluster !== "devnet") {
    throw new ClusterError(`SOLANA_CLUSTER must be "devnet" or "localnet", got "${solanaCluster}"`);
  }
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ClusterError(`cannot reach the RPC to verify the cluster (refusing): ${reason}`);
  }
  if (genesis !== DEVNET_GENESIS_HASH) {
    throw new ClusterError(`the RPC serves ${describeGenesis(genesis)}, not Solana devnet`);
  }
  return "devnet";
}
