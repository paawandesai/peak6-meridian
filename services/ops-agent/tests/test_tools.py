from datetime import date

import pytest
from meridian_ops_agent.models import SourceReport
from meridian_ops_agent.tools import (
    READ_ONLY_TOOL_NAMES,
    FixtureTools,
    ReadOnlyTools,
    ToolPolicyError,
    assert_read_only,
)


def test_fixture_tools_return_fixtures_and_record_calls() -> None:
    reports = [SourceReport(name="tiingo", raw="x")]
    tools: ReadOnlyTools = FixtureTools(reports, "log")
    assert tools.source_closes("AAPL", date(2026, 10, 6)) == reports
    assert tools.settlement_log("inc-1") == "log"
    assert isinstance(tools, FixtureTools)
    assert tools.calls == [
        ("source_closes", ("AAPL", date(2026, 10, 6))),
        ("settlement_log", ("inc-1",)),
    ]


def test_fixture_tools_pass_the_read_only_policy() -> None:
    assert_read_only(FixtureTools([]))


def test_policy_rejects_extra_callables() -> None:
    class Dangerous(FixtureTools):
        def sign_transaction(self, payload: bytes) -> bytes:
            return payload

    with pytest.raises(ToolPolicyError, match="sign_transaction"):
        assert_read_only(Dangerous([]))


def test_policy_rejects_incomplete_tools() -> None:
    class Partial:
        def settlement_log(self, incident_id: str) -> str:
            return ""

    with pytest.raises(ToolPolicyError, match="missing read tools"):
        assert_read_only(Partial())


def test_allowlist_is_exactly_the_two_read_tools() -> None:
    assert frozenset({"source_closes", "settlement_log"}) == READ_ONLY_TOOL_NAMES
