import json
from datetime import UTC, date, datetime

import pytest
from meridian_ops_agent.agent import investigate, parse_llm_draft
from meridian_ops_agent.llm import LLMRequest, LLMResponse, ScriptedLLM
from meridian_ops_agent.models import Incident, LLMDraft, SourceClose, SourceReport, Violation
from meridian_ops_agent.prompt import BLOCK_BEGIN, SYSTEM_PROMPT
from meridian_ops_agent.tools import FixtureTools, ToolPolicyError

AS_OF = datetime(2026, 10, 6, 20, 5, tzinfo=UTC)
M1 = "AAPL-20261006-250"


def make_report(name: str, cents: int | None, raw: str = "") -> SourceReport:
    close = SourceClose(name=name, close_cents=cents, as_of=AS_OF) if cents else None
    return SourceReport(name=name, close=close, raw=raw)


def reply(price: int | None, note: str = "both agree", market: str = M1) -> str:
    return json.dumps({"market": market, "proposed_price_cents": price, "note": note})


@pytest.fixture
def incident() -> Incident:
    return Incident(
        incident_id="inc-1",
        ticker="AAPL",
        trading_date=date(2026, 10, 6),
        markets=[M1, "AAPL-20261006-260"],
        failure="feed stale",
    )


@pytest.fixture
def tools() -> FixtureTools:
    return FixtureTools(
        [make_report("tiingo", 25012, "raw1"), make_report("twelvedata", 25010, "raw2")], "log"
    )


def test_accepted_draft_is_built_from_fetched_evidence(
    incident: Incident, tools: FixtureTools
) -> None:
    llm = ScriptedLLM([reply(25011, "within range")])
    result = investigate(incident, tools, llm)
    assert result.status == "accepted" and result.violations == [] and result.llm_called
    assert result.draft is not None
    assert result.draft.proposed_price_cents == 25011
    assert result.draft.sources == result.evidence.closes
    assert result.draft.spread_bps == result.evidence.spread_bps == 0
    assert result.draft.note == "within range"
    assert [name for name, _ in tools.calls] == ["source_closes", "settlement_log"]
    request = llm.requests[0]
    assert request.system == SYSTEM_PROMPT and request.user.count(BLOCK_BEGIN) == 4


def test_prose_around_the_json_is_tolerated(incident: Incident, tools: FixtureTools) -> None:
    text = "Here is my answer:\n```json\n" + reply(25012) + "\n```\nThanks."
    result = investigate(incident, tools, ScriptedLLM([text]))
    assert result.status == "accepted"


def test_refusal_is_rejected_without_parsing(incident: Incident, tools: FixtureTools) -> None:
    class Refusing:
        def complete(self, request: LLMRequest) -> LLMResponse:
            return LLMResponse(text=reply(25012), model="m", stop_reason="refusal")

    result = investigate(incident, tools, Refusing())
    assert result.status == "rejected" and result.draft is None
    assert [v.code for v in result.violations] == ["llm_refusal"]


@pytest.mark.parametrize(
    "text",
    ["", "no json here", "{not json", '{"a": 1} {', '{"market": 1}', "[1, 2]", "}{"],
)
def test_unparseable_outputs_are_rejected(
    incident: Incident, tools: FixtureTools, text: str
) -> None:
    result = investigate(incident, tools, ScriptedLLM([text]))
    assert result.status == "rejected" and result.draft is None
    assert [v.code for v in result.violations] == ["unparseable_output"]


def test_null_price_is_rejected_as_no_price(incident: Incident, tools: FixtureTools) -> None:
    result = investigate(incident, tools, ScriptedLLM([reply(None, "insufficient evidence")]))
    assert [v.code for v in result.violations] == ["no_price_proposed"]
    assert result.draft is None


def test_market_outside_the_incident_is_rejected(incident: Incident, tools: FixtureTools) -> None:
    result = investigate(incident, tools, ScriptedLLM([reply(25012, market="TSLA-20261006-400")]))
    assert result.status == "rejected"
    assert result.draft is not None  # the draft itself is well formed; the market is wrong
    assert [v.code for v in result.violations] == ["market_not_in_incident"]


def test_invalid_draft_fields_are_rejected_without_echoing_input(
    incident: Incident, tools: FixtureTools
) -> None:
    result = investigate(incident, tools, ScriptedLLM([reply(25012, "sk-ant-aaaaaaaaaaaaaaaa")]))
    assert [v.code for v in result.violations] == ["invalid_draft"]
    assert result.violations[0].detail == "note:value_error"
    assert result.draft is None


def test_out_of_range_price_is_rejected(incident: Incident, tools: FixtureTools) -> None:
    result = investigate(incident, tools, ScriptedLLM([reply(0)]))
    assert [v.code for v in result.violations] == ["price_out_of_range"]
    assert result.draft is not None and result.status == "rejected"


def test_no_evidence_skips_the_model_entirely(incident: Incident) -> None:
    tools = FixtureTools([make_report("tiingo", None, "503"), make_report("twelvedata", None)])
    llm = ScriptedLLM([])  # any call would raise ScriptExhausted
    result = investigate(incident, tools, llm)
    assert result.status == "rejected" and not result.llm_called
    assert [v.code for v in result.violations] == ["missing_sources"]
    assert result.evidence.closes == [] and llm.requests == []


def test_tools_outside_the_allowlist_are_refused_before_any_call(incident: Incident) -> None:
    class Signing(FixtureTools):
        def send_transaction(self, tx: bytes) -> str:
            return "sig"

    tools = Signing([make_report("tiingo", 25012)])
    with pytest.raises(ToolPolicyError):
        investigate(incident, tools, ScriptedLLM([reply(25012)]))
    assert tools.calls == []


def test_parse_llm_draft_returns_models_or_violations() -> None:
    parsed = parse_llm_draft(reply(1, "n"))
    assert isinstance(parsed, LLMDraft) and parsed.proposed_price_cents == 1
    bad = parse_llm_draft('{"market": "m", "proposed_price_cents": "abc"}')
    assert isinstance(bad, Violation) and bad.code == "unparseable_output"
    assert "abc" not in bad.detail
