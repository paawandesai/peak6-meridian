/**
 * Cluster guard for the manual and automatic settlement paths.
 *
 * INTERIM: M2-01 owns the shared `assertCluster` (`packages/client/src/cluster.ts`). This module
 * has the same signature and semantics so `settle-now` already refuses anything that is not
 * localnet or devnet; once M2-01 is on `main`, this file is replaced by a re-export of the shared
 * function. Error messages never contain the RPC URL (it may embed an API key).
 */
export type ClusterName = "localnet" | "devnet";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export interface ClusterCheck {
  readonly cluster: string;
  readonly rpcUrl: string;
  readonly getGenesisHash: () => Promise<string>;
}

export type AssertCluster = (check: ClusterCheck) => Promise<ClusterName>;

const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

/** Resolves to the verified cluster name or throws; decided by genesis hash, not hostname (devnet). */
export const assertCluster: AssertCluster = async ({ cluster, rpcUrl, getGenesisHash }) => {
  if (cluster === "localnet") {
    if (!LOOPBACK.test(rpcUrl)) {
      throw new Error("cluster localnet requires a loopback RPC URL");
    }
    return "localnet";
  }
  if (cluster !== "devnet") {
    throw new Error(
      `unsupported cluster ${JSON.stringify(cluster)}: only localnet and devnet are allowed`,
    );
  }
  let hash: string;
  try {
    hash = await getGenesisHash();
  } catch {
    throw new Error("cannot verify the cluster: the RPC endpoint is unreachable");
  }
  if (hash !== DEVNET_GENESIS_HASH) {
    throw new Error("the RPC endpoint is not devnet (genesis hash mismatch); refusing to continue");
  }
  return "devnet";
};
