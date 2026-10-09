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
from pathlib import Path

# Narrow imports from ops-agent (M3-05 on !52, merges before M3-07)
from meridian_ops_agent.models import SourceClose, SourceReport
from meridian_ops_agent.server import OpsApp, make_server
from meridian_ops_agent.store import IncidentStore
from meridian_ops_agent.tools import FixtureTools


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

    # Parse reports: each has a name and an optional SourceClose
    reports = [
        SourceReport.model_validate(r)
        for r in fixture_data.get("reports", [])
    ]

    # Tools factory returns FixtureTools with the recorded data
    def tools_factory() -> FixtureTools:
        return FixtureTools(reports, log=fixture_data.get("settlement_log", ""))

    store = IncidentStore(store_path)
    llm = None  # Deterministic fallback only for AC3

    app = OpsApp(token=service_token, store=store, tools=tools_factory, llm=llm)
    server = make_server(app, "127.0.0.1", port)
    logging.info(f"Demo ops-agent (FixtureTools, no LLM) listening on 127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
