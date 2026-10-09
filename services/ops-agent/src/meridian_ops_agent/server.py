"""HTTP surface of the ops agent: `POST /incidents` and `GET /drafts` behind a bearer token.

stdlib only (no web framework, no new dependency). `OpsApp.handle` is pure request handling so
tests need no socket. The service only reads and drafts: it never holds, reads or uses key
material and cannot sign (NFR-11, AB-20).
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import uuid
from collections.abc import Callable, Mapping
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from meridian_ops_agent.agent import InvestigationResult, investigate_with_fallback
from meridian_ops_agent.llm import LLMClient
from meridian_ops_agent.models import Incident, StrictModel, Ticker
from meridian_ops_agent.store import IncidentStore
from meridian_ops_agent.tools import ReadOnlyTools, calendar_check

__all__ = ["MAX_BODY_BYTES", "IncidentRequest", "OpsApp", "main", "make_server"]

MAX_BODY_BYTES = 64 * 1024
MIN_TOKEN_CHARS = 8
log = logging.getLogger("meridian_ops_agent.server")

Response = tuple[int, dict[str, Any] | list[Any]]
ToolsFactory = Callable[[], ReadOnlyTools]


class IncidentRequest(StrictModel):
    """`POST /incidents` body (architecture.md): the id is assigned by the service."""

    trading_date: date
    ticker: Ticker
    markets: list[str]
    failure: str


class OpsApp:
    def __init__(
        self,
        *,
        token: str,
        store: IncidentStore,
        tools: ToolsFactory,
        llm: LLMClient | None,
    ) -> None:
        if len(token) < MIN_TOKEN_CHARS:
            raise ValueError(f"SERVICE_TOKEN must be at least {MIN_TOKEN_CHARS} characters")
        self._token = token.encode()
        self._store = store
        self._tools = tools
        self._llm = llm

    def handle(self, method: str, path: str, headers: Mapping[str, str], body: bytes) -> Response:
        if not self._authorized(headers.get("Authorization", "")):
            return 401, {"error": "missing or invalid bearer token"}
        if path == "/incidents":
            return self._post_incident(body) if method == "POST" else (405, {"error": "use POST"})
        if path == "/drafts":
            if method != "GET":
                return 405, {"error": "use GET"}
            return 200, [d.model_dump(mode="json") for d in self._store.drafts()]
        return 404, {"error": "not found"}

    def _authorized(self, header: str) -> bool:
        scheme, _, supplied = header.partition(" ")
        return scheme == "Bearer" and hmac.compare_digest(supplied.encode(), self._token)

    def _post_incident(self, body: bytes) -> Response:
        if len(body) > MAX_BODY_BYTES:
            return 413, {"error": "body too large"}
        try:
            request = IncidentRequest.model_validate(json.loads(body))
            incident = Incident(
                incident_id=f"inc-{uuid.uuid4().hex[:16]}",
                ticker=request.ticker,
                trading_date=request.trading_date,
                markets=request.markets,
                failure=request.failure,
            )
        except (json.JSONDecodeError, UnicodeDecodeError, ValidationError):
            return 400, {"error": "invalid incident"}
        self._store.add(incident)
        self._store.complete(self._investigate(incident))
        return 202, {"incident_id": incident.incident_id}

    def _investigate(self, incident: Incident) -> InvestigationResult:
        calendar = calendar_check(incident.trading_date).summary
        result = investigate_with_fallback(incident, self._tools(), self._llm, calendar=calendar)
        log.info(
            json.dumps(
                {
                    "event": "incident_processed",
                    "incident_id": incident.incident_id,
                    "status": result.status,
                    "fallback": result.fallback,
                    "fallback_reason": result.fallback_reason,
                    "violations": [v.code for v in result.violations],
                }
            )
        )
        return result


def make_server(app: OpsApp, host: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def _serve(self) -> None:
            length_str = self.headers.get("Content-Length")
            try:
                length = int(length_str) if length_str else 0
                if length < 0:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error": "negative Content-Length"}')
                    return
            except ValueError:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error": "invalid Content-Length"}')
                return
            body = self.rfile.read(min(length, MAX_BODY_BYTES + 1)) if length else b""
            status, payload = app.handle(
                self.command, self.path.split("?", 1)[0], dict(self.headers), body
            )
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_DELETE = _serve

        def log_message(self, format: str, *args: object) -> None:
            return  # request lines can carry paths; the app logs structured events instead

    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:  # pragma: no cover - process wiring, exercised by deployment
    from meridian_ops_agent.budget import Budget
    from meridian_ops_agent.live import AnthropicLLM
    from meridian_ops_agent.llm import LoggedLLM
    from meridian_ops_agent.tools import HttpSourceTools

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    llm: LLMClient | None = None
    # the SDK reads ANTHROPIC_API_KEY from the env
    if os.environ.get("OPS_AGENT_LLM") == "anthropic":
        import anthropic

        budget = Budget.from_env()
        llm = LoggedLLM(AnthropicLLM.from_env(anthropic.Anthropic(), budget), budget)
    store_path = Path(os.environ.get("OPS_AGENT_STORE", "ops-agent-store.json"))

    def tools() -> ReadOnlyTools:
        return HttpSourceTools(
            tiingo_key=os.environ["TIINGO_API_KEY"],
            twelvedata_key=os.environ["TWELVEDATA_API_KEY"],
            log_reader=lambda _incident_id: "",
        )

    app = OpsApp(
        token=os.environ["SERVICE_TOKEN"], store=IncidentStore(store_path), tools=tools, llm=llm
    )
    host = os.environ.get("OPS_AGENT_HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "4200"))
    server = make_server(app, host, port)
    server.serve_forever()


if __name__ == "__main__":  # pragma: no cover
    main()
