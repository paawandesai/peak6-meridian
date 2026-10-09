import json
import threading
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from meridian_quant.prices import PriceError, Spot
from meridian_quant.server import STALE_AFTER_SECS, MarketInfo, Service, handle_request, make_server

NOW = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)  # 14:00 EDT
CLOSE = int(datetime(2026, 10, 8, 20, 0, tzinfo=UTC).timestamp())
TOKEN = "local-dev-token"
AUTH = f"Bearer {TOKEN}"


class FakeSources:
    def __init__(self, spot_age: float = 2, closes_ok: bool = True, spot_ok: bool = True) -> None:
        self.spot_age = spot_age
        self.closes_ok = closes_ok
        self.spot_ok = spot_ok
        self.spot_calls = 0

    def markets(self) -> list[MarketInfo]:
        return [
            MarketInfo(market="M180", ticker="NVDA", strike_cents=18_000, close_ts=CLOSE),
            MarketInfo(market="M190", ticker="NVDA", strike_cents=19_000, close_ts=CLOSE),
            MarketInfo(market="A", ticker="AAPL", strike_cents=23_000, close_ts=CLOSE),
        ]

    def spot(self, ticker: str) -> Spot:
        self.spot_calls += 1
        if not self.spot_ok or ticker == "AAPL":
            raise PriceError("no price")
        return Spot(
            ticker=ticker,
            price=Decimal("181.42"),
            as_of=NOW - timedelta(seconds=self.spot_age),
        )

    def closes(self, ticker: str) -> list[Decimal]:
        if not self.closes_ok:
            return [Decimal(100)] * 5
        return [Decimal(100) + (i % 3) for i in range(30)]


def service(sources: FakeSources | None = None) -> Service:
    return Service(sources=sources or FakeSources(), token=TOKEN, now=lambda: NOW)


def get(svc: Service, auth: str | None) -> tuple[int, object]:
    status, body = handle_request(svc, "GET", "/fair-values", auth)
    return status, json.loads(body)


@pytest.mark.parametrize(
    "auth", [None, "", "Bearer", "Bearer wrong", "Basic local-dev-token", TOKEN]
)
def test_rejects_missing_or_invalid_bearer(auth: str | None) -> None:
    status, body = get(service(), auth)
    assert status == 401
    assert body == {"error": "unauthorized"}


def test_returns_fair_values_with_contract_fields() -> None:
    status, body = get(service(), AUTH)
    assert status == 200
    assert isinstance(body, list)
    assert [row["market"] for row in body] == ["M180", "M190"]  # AAPL has no price: left out
    row = body[0]
    assert set(row) == {
        "market",
        "ticker",
        "strike_cents",
        "fair_cents",
        "sigma",
        "spot",
        "as_of",
        "stale",
    }
    assert row["spot"] == "181.42"
    assert 1 <= body[1]["fair_cents"] <= body[0]["fair_cents"] <= 99
    assert row["sigma"] >= 0.15
    assert row["stale"] is False


def test_spot_older_than_10s_is_flagged_stale() -> None:
    fresh = get(service(FakeSources(spot_age=STALE_AFTER_SECS)), AUTH)[1]
    stale = get(service(FakeSources(spot_age=STALE_AFTER_SECS + 1)), AUTH)[1]
    assert isinstance(fresh, list)
    assert isinstance(stale, list)
    assert fresh[0]["stale"] is False
    assert stale[0]["stale"] is True


def test_missing_closes_or_spot_omits_the_market_instead_of_defaulting() -> None:
    assert get(service(FakeSources(closes_ok=False)), AUTH) == (200, [])
    assert get(service(FakeSources(spot_ok=False)), AUTH) == (200, [])


def test_health_endpoint_returns_ok() -> None:
    status, body = handle_request(service(), "GET", "/health", AUTH)
    assert status == 200
    assert json.loads(body) == {"service": "quant", "status": "ok"}


def test_health_endpoint_rejects_invalid_method() -> None:
    status, body = handle_request(service(), "POST", "/health", AUTH)
    assert status == 405
    assert json.loads(body) == {"error": "method not allowed"}


@pytest.mark.parametrize(
    "auth", [None, "", "Bearer", "Bearer wrong", "Basic local-dev-token", TOKEN]
)
def test_health_endpoint_rejects_missing_or_invalid_bearer(auth: str | None) -> None:
    status, body = handle_request(service(), "GET", "/health", auth)
    assert status == 401
    assert json.loads(body) == {"error": "unauthorized"}


def test_a_ticker_is_fetched_once_per_request() -> None:
    sources = FakeSources()
    get(service(sources), AUTH)
    assert sources.spot_calls == 2  # NVDA once for two strikes, AAPL once


def test_routing() -> None:
    svc = service()
    assert handle_request(svc, "GET", "/other", AUTH)[0] == 404
    assert handle_request(svc, "POST", "/fair-values", AUTH)[0] == 405


def test_empty_token_is_refused() -> None:
    with pytest.raises(ValueError, match="SERVICE_TOKEN"):
        Service(sources=FakeSources(), token="")


def test_http_server_end_to_end_on_loopback() -> None:
    server = make_server(service(), "127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/fair-values?x=1"
        request = urllib.request.Request(url, headers={"Authorization": AUTH})
        with urllib.request.urlopen(request, timeout=5) as response:
            assert response.status == 200
            assert len(json.loads(response.read())) == 2
        with pytest.raises(urllib.error.HTTPError) as denied:
            urllib.request.urlopen(url, timeout=5)
        assert denied.value.code == 401
    finally:
        server.shutdown()
        server.server_close()


def test_one_unpriceable_market_is_skipped_not_a_500(caplog: pytest.LogCaptureFixture) -> None:
    class BadStrike(FakeSources):
        def markets(self) -> list[MarketInfo]:
            bad = MarketInfo(market="BAD", ticker="NVDA", strike_cents=0, close_ts=CLOSE)
            return [bad, *super().markets()]

    with caplog.at_level("WARNING", logger="meridian_quant.server"):
        status, body = get(service(BadStrike()), AUTH)
    assert status == 200
    assert isinstance(body, list)
    assert [row["market"] for row in body] == ["M180", "M190"]
    assert "BAD" in caplog.text
    assert "NVDA" in caplog.text


def test_skipped_ticker_is_named_in_the_log(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level("WARNING", logger="meridian_quant.server"):
        get(service(), AUTH)
    assert "AAPL" in caplog.text
