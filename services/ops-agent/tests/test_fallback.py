import json
import logging
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from meridian_ops_agent.agent import (
    deterministic_note,
    investigate_with_fallback,
    median_cents,
)
from meridian_ops_agent.budget import Budget, BudgetExhausted
from meridian_ops_agent.llm import LLMRequest, LLMResponse, LoggedLLM, ScriptedLLM
from meridian_ops_agent.models import Evidence, Incident, SourceClose, SourceReport
from meridian_ops_agent.tools import FixtureTools

AS_OF = datetime(2026, 10, 6, 20, 5, tzinfo=UTC)
TRADING_DATE = date(2026, 10, 6)
MARKETS = ["AAPL-20261006-250", "AAPL-20261006-260"]


def make_close(name: str, cents: int) -> SourceClose:
    return SourceClose(name=name, close_cents=cents, as_of=AS_OF)


def make_report(name: str, cents: int | None, raw: str = "") -> SourceReport:
    close = make_close(name, cents) if cents is not None else None
    return SourceReport(name=name, close=close, raw=raw)


@pytest.fixture
def incident() -> Incident:
    return Incident(
        incident_id="inc-1", ticker="AAPL", trading_date=TRADING_DATE, markets=MARKETS, failure="f"
    )


@pytest.fixture
def reports() -> list[SourceReport]:
    return [make_report("tiingo", 25012), make_report("twelvedata", 25010)]


class FailingLLM:
    def complete(self, request: LLMRequest) -> LLMResponse:
        raise TimeoutError("api down")


class BrokeLLM:
    def complete(self, request: LLMRequest) -> LLMResponse:
        raise BudgetExhausted("cap reached")


def tools(reports: list[SourceReport]) -> FixtureTools:
    return FixtureTools(reports, "log")


def test_median_of_odd_and_even_counts() -> None:
    assert median_cents([30, 10, 20]) == 20
    assert median_cents([25012, 25010]) == 25011
    assert median_cents([5]) == 5


def test_note_is_the_source_table_with_no_untrusted_text() -> None:
    evidence = Evidence(
        ticker="AAPL",
        trading_date=TRADING_DATE,
        closes=[make_close("tiingo", 25012), make_close("twelvedata", 25010)],
    )
    note = deterministic_note(evidence, "trading day, regular close")
    assert "tiingo: 250.12" in note and "twelvedata: 250.10" in note
    assert "Median 250.11" in note and "spread 0 bps" in note
    assert "Calendar: trading day, regular close" in note


@pytest.mark.parametrize(
    ("llm", "reason"),
    [(None, "no_llm"), (FailingLLM(), "TimeoutError"), (BrokeLLM(), "budget_exhausted")],
)
def test_fallback_when_the_model_is_missing_failing_or_over_budget(
    incident: Incident, reports: list[SourceReport], llm: object, reason: str
) -> None:
    result = investigate_with_fallback(incident, tools(reports), llm, calendar="open")  # type: ignore[arg-type]
    assert result.fallback and result.fallback_reason == reason and not result.llm_called
    assert result.status == "accepted" and result.violations == []
    assert [d.market for d in result.drafts] == MARKETS
    assert all(d.proposed_price_cents == 25011 for d in result.drafts)
    assert result.draft == result.drafts[0]
    assert result.draft.note.startswith("Deterministic note (no model)")


def test_fallback_with_every_source_failed_is_rejected(incident: Incident) -> None:
    result = investigate_with_fallback(incident, tools([make_report("tiingo", None, "503")]), None)
    assert result.status == "rejected" and result.draft is None
    assert [v.code for v in result.violations] == ["missing_sources"]


def test_model_path_is_used_when_available_and_a_rejected_draft_is_not_replaced(
    incident: Incident, reports: list[SourceReport]
) -> None:
    good = json.dumps({"market": MARKETS[0], "proposed_price_cents": 25011, "note": "ok"})
    ok = investigate_with_fallback(incident, tools(reports), ScriptedLLM([good]))
    assert ok.llm_called and not ok.fallback and len(ok.drafts) == 1
    bad = json.dumps({"market": MARKETS[0], "proposed_price_cents": 99999, "note": "x"})
    rejected = investigate_with_fallback(incident, tools(reports), ScriptedLLM([bad]))
    assert rejected.status == "rejected" and not rejected.fallback
    assert [v.code for v in rejected.violations] == ["price_out_of_range"]


def test_budget_exhaustion_blocks_the_call_then_falls_back(
    incident: Incident, reports: list[SourceReport]
) -> None:
    from meridian_ops_agent.live import AnthropicLLM

    class NeverCalled:
        class messages:
            @staticmethod
            def create(**_: object) -> object:
                raise AssertionError("the model must not be called over budget")

    llm = AnthropicLLM(NeverCalled(), "claude-sonnet-5-5", Budget(Decimal("0")))  # type: ignore[arg-type]
    result = investigate_with_fallback(incident, tools(reports), llm)
    assert result.fallback and result.fallback_reason == "budget_exhausted"


def test_every_model_call_logs_tokens_cost_and_spend(
    caplog: pytest.LogCaptureFixture,
) -> None:
    budget = Budget(Decimal("20"))

    class Inner:
        def complete(self, request: LLMRequest) -> LLMResponse:
            budget.charge("claude-sonnet-5-5", 1000, 200)
            return LLMResponse(
                text="SECRET-REPLY", model="claude-sonnet-5-5", input_tokens=1000, output_tokens=200
            )

    llm = LoggedLLM(Inner(), budget)
    with caplog.at_level(logging.INFO, logger="meridian_ops_agent.llm"):
        llm.complete(LLMRequest(system="SECRET-PROMPT", user="u"))
    entry = json.loads(caplog.records[-1].getMessage())
    assert entry["event"] == "llm_call" and entry["input_tokens"] == 1000
    assert Decimal(entry["cost_usd"]) == Decimal("0.004")
    assert Decimal(entry["spent_usd"]) == Decimal("0.004")
    assert Decimal(entry["remaining_usd"]) == Decimal("19.996")
    assert "SECRET" not in caplog.text


def test_failed_call_is_logged_by_class_only(caplog: pytest.LogCaptureFixture) -> None:
    llm = LoggedLLM(FailingLLM(), Budget(Decimal("20")))
    with (
        caplog.at_level(logging.INFO, logger="meridian_ops_agent.llm"),
        pytest.raises(TimeoutError),
    ):
        llm.complete(LLMRequest(system="s", user="u"))
    entry = json.loads(caplog.records[-1].getMessage())
    assert entry["event"] == "llm_call_failed" and entry["error"] == "TimeoutError"
    assert "api down" not in caplog.text
