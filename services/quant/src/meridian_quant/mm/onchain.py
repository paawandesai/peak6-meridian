"""HTTP client for M3-01 /fair-values (M3-02).

Production uses chain.py (ChainMarketSource, ChainOrderClient) for on-chain operations.
This module provides HttpFairValueSource for fetching fair values from M3-01 service.
"""

import httpx

from .types import FairValue


class HttpFairValueSource:
    """HTTP client for M3-01 /fair-values with httpx timeout (operator directive: REAL)."""

    def __init__(self, base_url: str, service_token: str, timeout_secs: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.service_token = service_token
        self.timeout = timeout_secs

    async def fetch_fair_values(self) -> list[FairValue]:
        """GET M3-01 /fair-values with bearer token and httpx timeout.

        REAL implementation complete per operator directive.
        """
        headers = {"Authorization": f"Bearer {self.service_token}"}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.get(f"{self.base_url}/fair-values", headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return [
                FairValue(
                    market=fv["market"],
                    ticker=fv["ticker"],
                    strike_cents=fv["strike_cents"],
                    fair_cents=fv["fair_cents"],
                    sigma=fv["sigma"],
                    spot=fv["spot"],
                    as_of=fv["as_of"],
                    stale=fv.get("stale", False),
                )
                for fv in data
            ]


# Backwards compatibility alias
FairValueHttpClient = HttpFairValueSource
