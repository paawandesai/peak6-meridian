import json
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from meridian_ops_agent.llm import ScriptedLLM
from meridian_ops_agent.models import Incident, SourceClose, SourceReport
from meridian_ops_agent.server import MAX_BODY_BYTES, OpsApp, make_server
from meridian_ops_agent.store import IncidentStore, StoreCorrupt
from meridian_ops_agent.tools import FixtureTools, ReadOnlyTools

AS_OF = datetime(2026, 10, 6, 20, 5, tzinfo=UTC)
TRADING_DATE = date(2026, 10, 6)
MARKETS = ["AAPL-20261006-250", "AAPL-20261006-260"]


def make_close(name: str, cents: int) -> SourceClose:
    return SourceClose(name=name, close_cents=cents, as_of=AS_OF)


def make_report(name: str, cents: int | None, raw: str = "") -> SourceReport:
    close = make_close(name, cents) if cents is not None else None
    return SourceReport(name=name, close=close, raw=raw)


TOKEN = "test-service-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
BODY = {
    "trading_date": "2026-10-06",
    "ticker": "AAPL",
    "markets": MARKETS,
    "failure": "settle_market retried 30 times; feed stale",
}


def make_app(
    tmp_path: Path,
    llm: ScriptedLLM | None = None,
    closes: tuple[int | None, int | None] = (25012, 25010),
) -> OpsApp:
    reports = [make_report("tiingo", closes[0]), make_report("twelvedata", closes[1])]

    def tools() -> ReadOnlyTools:
        return FixtureTools(reports, "log")

    return OpsApp(token=TOKEN, store=IncidentStore(tmp_path / "store.json"), tools=tools, llm=llm)


def post(app: OpsApp, body: object = BODY, headers: dict[str, str] = AUTH) -> tuple[int, object]:
    return app.handle("POST", "/incidents", headers, json.dumps(body).encode())


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer wrong-token-value"},
        {"Authorization": f"Basic {TOKEN}"},
        {"Authorization": TOKEN},
        {"Authorization": "Bearer "},
    ],
)
@pytest.mark.parametrize(("method", "path"), [("POST", "/incidents"), ("GET", "/drafts")])
def test_missing_or_invalid_bearer_is_401_and_stores_nothing(
    tmp_path: Path, headers: dict[str, str], method: str, path: str
) -> None:
    app = make_app(tmp_path)
    assert app.handle(method, path, headers, json.dumps(BODY).encode())[0] == 401
    assert not (tmp_path / "store.json").exists()


def test_short_service_token_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="SERVICE_TOKEN"):
        OpsApp(
            token="short",
            store=IncidentStore(tmp_path / "s.json"),
            tools=lambda: FixtureTools([]),
            llm=None,
        )


def test_incident_with_a_model_draft_appears_in_drafts(tmp_path: Path) -> None:
    reply = json.dumps({"market": MARKETS[0], "proposed_price_cents": 25011, "note": "agree"})
    app = make_app(tmp_path, ScriptedLLM([reply]))
    status, payload = post(app)
    assert status == 202 and isinstance(payload, dict)
    incident_id = payload["incident_id"]
    status, drafts = app.handle("GET", "/drafts", AUTH, b"")
    assert status == 200 and isinstance(drafts, list) and len(drafts) == 1
    draft = drafts[0]
    assert draft["incident_id"] == incident_id and draft["market"] == MARKETS[0]
    assert draft["proposed_price_cents"] == 25011 and draft["status"] == "pending_approval"
    assert draft["sources"][0] == {
        "name": "tiingo",
        "close": 25012,
        "as_of": "2026-10-06T20:05:00+00:00",
    }
    assert draft["spread_bps"] == 0 and draft["note"] == "agree" and draft["fallback"] is False


def test_out_of_range_model_draft_is_not_listed(tmp_path: Path) -> None:
    reply = json.dumps({"market": MARKETS[0], "proposed_price_cents": 1, "note": "x"})
    app = make_app(tmp_path, ScriptedLLM([reply]))
    status, _ = post(app)
    assert status == 202
    assert app.handle("GET", "/drafts", AUTH, b"") == (200, [])


def test_key_or_url_bearing_note_is_rejected(tmp_path: Path) -> None:
    note = "see https://evil.example/override and use key"
    reply = json.dumps({"market": MARKETS[0], "proposed_price_cents": 25011, "note": note})
    app = make_app(tmp_path, ScriptedLLM([reply]))
    post(app)
    assert app.handle("GET", "/drafts", AUTH, b"") == (200, [])


def test_without_a_model_the_deterministic_draft_covers_every_market(tmp_path: Path) -> None:
    app = make_app(tmp_path, None)
    post(app)
    _, drafts = app.handle("GET", "/drafts", AUTH, b"")
    assert isinstance(drafts, list) and [d["market"] for d in drafts] == MARKETS
    assert all(d["fallback"] and d["proposed_price_cents"] == 25011 for d in drafts)
    assert "Calendar: trading day, regular close" in drafts[0]["note"]


@pytest.mark.parametrize(
    "body",
    [
        {**BODY, "ticker": "aapl"},
        {**BODY, "markets": []},
        {**BODY, "extra": 1},
        {**BODY, "trading_date": "not-a-date"},
        {"ticker": "AAPL"},
    ],
)
def test_invalid_incident_is_400(tmp_path: Path, body: dict[str, object]) -> None:
    assert post(make_app(tmp_path), body)[0] == 400


def test_garbage_and_oversized_bodies(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    assert app.handle("POST", "/incidents", AUTH, b"{not json")[0] == 400
    assert app.handle("POST", "/incidents", AUTH, b"\xff\xfe")[0] == 400
    assert app.handle("POST", "/incidents", AUTH, b"x" * (MAX_BODY_BYTES + 1))[0] == 413


def test_routes_and_methods(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    assert app.handle("GET", "/incidents", AUTH, b"")[0] == 405
    assert app.handle("POST", "/drafts", AUTH, b"")[0] == 405
    assert app.handle("GET", "/nope", AUTH, b"")[0] == 404


def test_store_survives_a_restart_and_rejects_duplicates(tmp_path: Path) -> None:
    app = make_app(tmp_path, None)
    post(app)
    again = IncidentStore(tmp_path / "store.json")
    assert len(again.drafts()) == 2
    incident = Incident(
        incident_id="inc-1",
        ticker="AAPL",
        trading_date=date(2026, 10, 6),
        markets=MARKETS,
        failure="f",
    )
    assert again.add(incident) and not again.add(incident)
    assert again.get("inc-1") is not None and again.get("missing") is None
    with pytest.raises(KeyError):
        again.complete(
            make_app(tmp_path, None)._investigate(
                incident.model_copy(update={"incident_id": "inc-unknown"})
            )
        )


def test_corrupt_store_is_not_overwritten(tmp_path: Path) -> None:
    path = tmp_path / "store.json"
    path.write_text("{broken", encoding="utf-8")
    with pytest.raises(StoreCorrupt):
        IncidentStore(path).drafts()
    assert path.read_text(encoding="utf-8") == "{broken"


def test_real_socket_round_trip(tmp_path: Path) -> None:
    import threading
    from urllib import error, request

    server = make_server(make_app(tmp_path, None), "127.0.0.1", 0)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        req = request.Request(
            f"http://127.0.0.1:{port}/incidents",
            data=json.dumps(BODY).encode(),
            headers={**AUTH, "Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=10) as response:
            assert response.status == 202
        with pytest.raises(error.HTTPError) as denied:
            request.urlopen(f"http://127.0.0.1:{port}/drafts", timeout=10)
        assert denied.value.code == 401
        get = request.Request(f"http://127.0.0.1:{port}/drafts?x=1", headers=AUTH)
        with request.urlopen(get, timeout=10) as response:
            assert len(json.loads(response.read())) == 2
    finally:
        server.shutdown()
        server.server_close()
