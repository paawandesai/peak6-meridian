"""Read-only tools the agent may use, and the policy that keeps them read-only (AB-20).

The agent never receives a tool that writes, signs, sends or fetches arbitrary URLs. The
allowlist below is the whole tool surface; `assert_read_only` refuses any object exposing more.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Protocol
from urllib import request as urlrequest

from meridian_ops_agent.models import SourceClose, SourceReport, StrictModel

__all__ = [
    "READ_ONLY_TOOL_NAMES",
    "AccountReader",
    "CalendarCheck",
    "FixtureTools",
    "HttpSourceTools",
    "ReadOnlyTools",
    "RpcAccountReader",
    "ToolPolicyError",
    "assert_read_only",
    "calendar_check",
    "urllib_fetch",
]

READ_ONLY_TOOL_NAMES: frozenset[str] = frozenset({"source_closes", "settlement_log"})


class ReadOnlyTools(Protocol):
    def source_closes(self, ticker: str, trading_date: date) -> list[SourceReport]:
        """Latest official daily close per data source, plus the raw response text."""
        ...

    def settlement_log(self, incident_id: str) -> str:
        """Automation's log lines for the failed settlement attempts (untrusted text)."""
        ...


class ToolPolicyError(PermissionError):
    """The tools object exposes something outside the read-only allowlist."""


def assert_read_only(tools: object) -> None:
    """Fail loudly if ``tools`` has any public callable that is not an allowlisted read tool."""
    exposed = {
        name
        for name in dir(tools)
        if not name.startswith("_") and callable(getattr(tools, name, None))
    }
    extra = exposed - READ_ONLY_TOOL_NAMES
    if extra:
        raise ToolPolicyError(f"tools expose non-allowlisted callables: {sorted(extra)}")
    missing = READ_ONLY_TOOL_NAMES - exposed
    if missing:
        raise ToolPolicyError(f"tools are missing read tools: {sorted(missing)}")


class FixtureTools:
    """Tools backed by fixed data: used by tests, evals and the local demo (D-033)."""

    def __init__(self, reports: list[SourceReport], log: str = "") -> None:
        self._reports = list(reports)
        self._log = log
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def source_closes(self, ticker: str, trading_date: date) -> list[SourceReport]:
        self.calls.append(("source_closes", (ticker, trading_date)))
        return list(self._reports)

    def settlement_log(self, incident_id: str) -> str:
        self.calls.append(("settlement_log", (incident_id,)))
        return self._log


# ---- calendar -----------------------------------------------------------------------------------
# NYSE full-day closures and early closes (13:00 ET) for 2026, mirroring services/automation's
# calendar. A read-only sanity check for the incident note; the automation calendar stays the
# source of truth for scheduling.
_HOLIDAYS_2026: dict[date, str] = {
    date(2026, 1, 1): "New Year's Day",
    date(2026, 1, 19): "Martin Luther King Jr. Day",
    date(2026, 2, 16): "Washington's Birthday",
    date(2026, 4, 3): "Good Friday",
    date(2026, 5, 25): "Memorial Day",
    date(2026, 6, 19): "Juneteenth",
    date(2026, 7, 3): "Independence Day (observed)",
    date(2026, 9, 7): "Labor Day",
    date(2026, 11, 26): "Thanksgiving Day",
    date(2026, 12, 25): "Christmas Day",
}
_EARLY_CLOSES_2026: frozenset[date] = frozenset({date(2026, 11, 27), date(2026, 12, 24)})


class CalendarCheck(StrictModel):
    trading_day: bool
    early_close: bool
    summary: str


def calendar_check(trading_date: date) -> CalendarCheck:
    """Whether NYSE was open on ``trading_date``; dates outside 2026 are reported as unknown."""
    if trading_date.weekday() >= 5:
        return CalendarCheck(trading_day=False, early_close=False, summary="weekend, market closed")
    if trading_date.year != 2026:
        return CalendarCheck(
            trading_day=True, early_close=False, summary="weekday (holiday table covers 2026 only)"
        )
    if (holiday := _HOLIDAYS_2026.get(trading_date)) is not None:
        return CalendarCheck(trading_day=False, early_close=False, summary=f"holiday: {holiday}")
    early = trading_date in _EARLY_CLOSES_2026
    return CalendarCheck(
        trading_day=True,
        early_close=early,
        summary="trading day, early close 13:00 ET" if early else "trading day, regular close",
    )


# ---- account reads ------------------------------------------------------------------------------
JsonRpc = Callable[[str, list[object]], object]


class AccountReader(Protocol):
    def market_state(self, market: str) -> str:
        """One-line, read-only summary of a market account (never key material)."""
        ...


class RpcAccountReader:
    """`getAccountInfo` over an injected JSON-RPC callable: existence, owner and size only."""

    def __init__(self, rpc: JsonRpc) -> None:
        self._rpc = rpc

    def market_state(self, market: str) -> str:
        try:
            result = self._rpc("getAccountInfo", [market, {"encoding": "base64"}])
        except Exception as exc:
            return f"account read failed ({type(exc).__name__})"
        value = result.get("value") if isinstance(result, dict) else None
        if not isinstance(value, dict):
            return "account not found"
        data = value.get("data")
        size = len(data[0]) * 3 // 4 if isinstance(data, list) and data else 0
        return f"account exists, owner {value.get('owner')}, about {size} data bytes"


# ---- provider closes ----------------------------------------------------------------------------
Fetch = Callable[[str, dict[str, str]], str]
Clock = Callable[[], datetime]

_TIINGO = "https://api.tiingo.com/tiingo/daily/{ticker}/prices?startDate={d}&endDate={d}"
_TWELVEDATA = "https://api.twelvedata.com/eod?symbol={ticker}&date={d}"
_ALLOWED_HOSTS = ("https://api.tiingo.com/", "https://api.twelvedata.com/")
_FETCH_TIMEOUT_S = 10


def urllib_fetch(url: str, headers: dict[str, str]) -> str:
    """HTTPS GET to the two provider hosts only, with a timeout. Raises on any failure."""
    if not url.startswith(_ALLOWED_HOSTS):
        raise ToolPolicyError("fetch refused: host is not a configured data provider")
    req = urlrequest.Request(url, headers=headers, method="GET")
    with urlrequest.urlopen(req, timeout=_FETCH_TIMEOUT_S) as response:
        return str(response.read(1_000_000).decode("utf-8", errors="replace"))


def _to_cents(value: object) -> int | None:
    """Exact decimal dollars to whole cents; anything else (or sub-cent noise) is None."""
    try:
        cents = Decimal(str(value)) * 100
    except InvalidOperation:
        return None
    return int(cents) if cents == cents.to_integral_value() and cents > 0 else None


class HttpSourceTools:
    """Live `ReadOnlyTools`: Tiingo and Twelve Data closes, plus the failed run's log lines.

    The provider keys travel in request headers only, so they appear in no URL, log or raw text;
    ``raw`` holds the response body (or an error class), which the prompt treats as untrusted.
    """

    def __init__(
        self,
        *,
        tiingo_key: str,
        twelvedata_key: str,
        log_reader: Callable[[str], str],
        fetch: Fetch = urllib_fetch,
        clock: Clock = lambda: datetime.now(UTC),
    ) -> None:
        self._sources = (
            ("tiingo", _TIINGO, {"Authorization": f"Token {tiingo_key}"}, "close"),
            ("twelvedata", _TWELVEDATA, {"Authorization": f"apikey {twelvedata_key}"}, "close"),
        )
        self._log_reader = log_reader
        self._fetch = fetch
        self._clock = clock

    def source_closes(self, ticker: str, trading_date: date) -> list[SourceReport]:
        reports: list[SourceReport] = []
        for name, template, headers, _field in self._sources:
            url = template.format(ticker=ticker, d=trading_date.isoformat())
            try:
                body = self._fetch(url, headers)
            except Exception as exc:
                reports.append(SourceReport(name=name, raw=f"fetch failed: {type(exc).__name__}"))
                continue
            reports.append(
                SourceReport(
                    name=name,
                    close=self._parse(name, body, trading_date),
                    raw=body[:10_000],
                )
            )
        return reports

    def settlement_log(self, incident_id: str) -> str:
        return self._log_reader(incident_id)

    def _parse(self, name: str, body: str, trading_date: date) -> SourceClose | None:
        try:
            payload = json.loads(body, parse_float=Decimal)
        except json.JSONDecodeError:
            return None
        row = payload[0] if isinstance(payload, list) and payload else payload
        if not isinstance(row, dict):
            return None
        stamp = str(row.get("date") or row.get("datetime") or "")
        if stamp[:10] != trading_date.isoformat():
            return None  # a close for another day is not this day's close
        cents = _to_cents(row.get("close"))
        if cents is None:
            return None
        return SourceClose(name=name, close_cents=cents, as_of=self._clock())
