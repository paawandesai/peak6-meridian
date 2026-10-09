from datetime import UTC, date, datetime

import pytest
from meridian_ops_agent.tools import (
    HttpSourceTools,
    RpcAccountReader,
    ToolPolicyError,
    assert_read_only,
    calendar_check,
    urllib_fetch,
)

D = date(2026, 10, 6)
NOW = datetime(2026, 10, 6, 21, 0, tzinfo=UTC)
TIINGO = '[{"date":"2026-10-06T00:00:00.000Z","close":250.12}]'
TWELVE = '{"datetime":"2026-10-06","close":"250.10"}'


def make(
    bodies: dict[str, str | Exception],
) -> tuple[HttpSourceTools, list[tuple[str, dict[str, str]]]]:
    seen: list[tuple[str, dict[str, str]]] = []

    def fetch(url: str, headers: dict[str, str]) -> str:
        seen.append((url, headers))
        body = bodies["tiingo" if "tiingo" in url else "twelvedata"]
        if isinstance(body, Exception):
            raise body
        return body

    tools = HttpSourceTools(
        tiingo_key="KEY-T",
        twelvedata_key="KEY-D",
        log_reader=lambda i: f"log {i}",
        fetch=fetch,
        clock=lambda: NOW,
    )
    return tools, seen


def test_closes_from_recorded_provider_responses_without_keys_in_urls() -> None:
    tools, seen = make({"tiingo": TIINGO, "twelvedata": TWELVE})
    assert_read_only(tools)
    reports = tools.source_closes("AAPL", D)
    assert [(r.name, r.close.close_cents if r.close else None) for r in reports] == [
        ("tiingo", 25012),
        ("twelvedata", 25010),
    ]
    assert reports[0].close is not None and reports[0].close.as_of == NOW
    assert all("KEY-" not in url for url, _ in seen)
    assert seen[0][1] == {"Authorization": "Token KEY-T"}
    assert tools.settlement_log("inc-1") == "log inc-1"


@pytest.mark.parametrize(
    "body",
    [
        "not json",
        "[]",
        '"str"',
        '[{"date":"2026-10-05","close":1.5}]',
        '[{"date":"2026-10-06","close":"abc"}]',
        '[{"date":"2026-10-06","close":250.123}]',
        '[{"date":"2026-10-06","close":-1}]',
        '[{"date":"2026-10-06"}]',
    ],
)
def test_unusable_provider_bodies_give_no_close(body: str) -> None:
    tools, _ = make({"tiingo": body, "twelvedata": body})
    assert all(r.close is None for r in tools.source_closes("AAPL", D))


def test_failing_source_is_reported_by_error_class_only() -> None:
    tools, _ = make({"tiingo": TimeoutError("KEY-T leaked"), "twelvedata": TWELVE})
    first, second = tools.source_closes("AAPL", D)
    assert first.close is None and first.raw == "fetch failed: TimeoutError"
    assert second.close is not None


def test_fetch_refuses_other_hosts() -> None:
    with pytest.raises(ToolPolicyError):
        urllib_fetch("https://evil.example/x", {})
    with pytest.raises(ToolPolicyError):
        urllib_fetch("file:///etc/passwd", {})


def test_account_reader_summaries() -> None:
    found = RpcAccountReader(lambda m, p: {"value": {"owner": "Prog1", "data": ["AAAA", "base64"]}})
    assert found.market_state("M1") == "account exists, owner Prog1, about 3 data bytes"
    assert RpcAccountReader(lambda m, p: {"value": None}).market_state("M1") == "account not found"

    def boom(method: str, params: list[object]) -> object:
        raise ConnectionError("rpc url secret")

    assert RpcAccountReader(boom).market_state("M1") == "account read failed (ConnectionError)"


@pytest.mark.parametrize(
    ("d", "trading", "early", "text"),
    [
        (date(2026, 10, 10), False, False, "weekend"),
        (date(2026, 11, 26), False, False, "Thanksgiving"),
        (date(2026, 11, 27), True, True, "early close"),
        (date(2026, 10, 6), True, False, "regular close"),
        (date(2027, 1, 4), True, False, "2026 only"),
    ],
)
def test_calendar_check(d: date, trading: bool, early: bool, text: str) -> None:
    result = calendar_check(d)
    assert (result.trading_day, result.early_close) == (trading, early)
    assert text in result.summary
