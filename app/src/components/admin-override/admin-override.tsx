"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMemo } from "react";

import { createOverrideActions, type OverrideActions } from "./override-chain";
import { OverrideSection } from "./override-section";
import { explorerTxUrl } from "@/lib/admin-chain";
import { loadPublicConfig } from "@/lib/config";

/** Actions that fail with a clear message until the wallet can sign. */
const NO_WALLET: OverrideActions = {
  approve: () => Promise.reject(new Error("wallet not connected")),
};

/** The admin page's mount point: wires the connected wallet to {@link OverrideSection}. */
export function AdminOverride({ nowSecs }: { readonly nowSecs: number | null }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const config = useMemo(() => loadPublicConfig(), []);
  const actions = useMemo(
    () =>
      publicKey === null || signTransaction === undefined || signAllTransactions === undefined
        ? NO_WALLET
        : createOverrideActions(
            connection,
            { publicKey, signTransaction, signAllTransactions },
            config,
          ),
    [connection, publicKey, signTransaction, signAllTransactions, config],
  );
  return (
    <OverrideSection
      nowSecs={nowSecs}
      actions={actions}
      explorerUrl={(signature) => explorerTxUrl(signature, config)}
    />
  );
}
