#!/usr/bin/env python3
"""
M3-07 demo launcher for ops-agent with FixtureTools (AC3: no live API calls).

Starts ops-agent HTTP server with recorded fixture data instead of HttpSourceTools.
Usage: python scripts/lib/demo/ops-agent-demo.py <port> <service-token> <store-path> <fixture-json>

TODO(!52): After M3-05 merges, request OPS_AGENT_TOOLS env var for cleaner tool injection.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import date
from pathlib import Path

# Narrow imports from ops-agent (M3-05 on !52, merges before M3-07)
from meridian_ops_agent.agent import investigate_with_fallback
from meridian_ops_agent.server import create_server
from meridian_ops_agent.store import Store
from meridian_ops_agent.tools import FixtureTools, SourceReport


def main() -> None:
    if len(sys.argv) != 5:
        print("Usage: ops-agent-demo.py <port> <service-token> <store-path> <fixture-json>")
        sys.exit(1)

    port = int(sys.argv[1])
    service_token = sys.argv[2]
    store_path = Path(sys.argv[3])
    fixture_path = Path(sys.argv[4])

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    # Load fixture data from JSON file
    with open(fixture_path) as f:
        fixture_data = json.load(f)

    reports = [
        SourceReport(
            source=r["source"],
            close_cents=r["close_cents"],
            as_of=r["as_of"],
        )
        for r in fixture_data.get("reports", [])
    ]

    tools = FixtureTools(reports, log=fixture_data.get("settlement_log", ""))
    store = Store(store_path)
    llm = None  # Deterministic fallback only for AC3

    def investigate(
        incident_id: str, trading_date: date, ticker: str, markets: list[str], failure: str
    ) -> None:
        investigate_with_fallback(
            incident_id=incident_id,
            trading_date=trading_date,
            ticker=ticker,
            markets=markets,
            failure=failure,
            tools=tools,
            llm=llm,
            store=store,
        )

    server = create_server(port, service_token, investigate, store.drafts)
    logging.info(f"Demo ops-agent (FixtureTools, no LLM) listening on :{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
