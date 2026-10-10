"""Demo-only overrides (devnet). Off by default; never active on mainnet.

MERIDIAN_DEMO_ALLOW_STALE_SPOT=1 lets the quant service and market maker price and quote from the
last available spot (e.g. the prior close, after hours) instead of pulling quotes, and counts the
time to a market's close on the wall clock rather than regular-session seconds. It only takes
effect when SOLANA_CLUSTER is devnet and the RPC URL is a devnet endpoint.
"""

import os
from collections.abc import Mapping

FLAG = "MERIDIAN_DEMO_ALLOW_STALE_SPOT"


def demo_allow_stale_spot(env: Mapping[str, str] | None = None) -> bool:
    e = os.environ if env is None else env
    if e.get(FLAG, "").strip() != "1":
        return False
    cluster = e.get("SOLANA_CLUSTER", "").strip().lower()
    rpc = e.get("SOLANA_RPC_URL", "").strip().lower()
    return cluster == "devnet" and "devnet" in rpc and "mainnet" not in rpc
