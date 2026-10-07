"""AB-15: the ops agent drafts an override price outside the evidence (hallucination or injection).

Mitigation under test: `validate_draft` rejects any draft outside [min, max] of the fetched
source closes, and `investigate` never returns `accepted` with such a draft.
"""

import json
from datetime import UTC, date, datetime

from hypothesis import given, settings
from hypothesis import strategies as st
from meridian_ops_agent.agent import investigate
from meridian_ops_agent.llm import ScriptedLLM
from meridian_ops_agent.models import Evidence, Incident, OverrideDraft, SourceClose, SourceReport
from meridian_ops_agent.tools import FixtureTools
from meridian_ops_agent.validate import validate_draft

AS_OF = datetime(2026, 10, 6, 20, 5, tzinfo=UTC)
TRADING_DATE = date(2026, 10, 6)
M1 = "AAPL-20261006-250"
MAX_CENTS = 10**9

closes_strategy = st.lists(
    st.builds(
        SourceClose,
        name=st.sampled_from(["tiingo", "twelvedata", "finnhub"]),
        close_cents=st.integers(min_value=1, max_value=MAX_CENTS),
        as_of=st.just(AS_OF),
    ),
    min_size=1,
    max_size=3,
)


def run(closes: list[SourceClose], price: int) -> tuple[str, OverrideDraft | None, set[str]]:
    incident = Incident(
        incident_id="inc-1", ticker="AAPL", trading_date=TRADING_DATE, markets=[M1], failure="x"
    )
    tools = FixtureTools([SourceReport(name=c.name, close=c) for c in closes])
    llm = ScriptedLLM([json.dumps({"market": M1, "proposed_price_cents": price, "note": "n"})])
    result = investigate(incident, tools, llm)
    return result.status, result.draft, {v.code for v in result.violations}


@settings(max_examples=300, deadline=None)
@given(closes=closes_strategy, price=st.integers(min_value=-(2**63), max_value=2**63))
def test_agent_never_accepts_a_price_outside_the_evidence(
    closes: list[SourceClose], price: int
) -> None:
    low = min(c.close_cents for c in closes)
    high = max(c.close_cents for c in closes)
    status, draft, codes = run(closes, price)
    if low <= price <= high:
        assert status == "accepted" and draft is not None
        assert draft.proposed_price_cents == price
    else:
        assert status == "rejected"
        assert codes & {"price_out_of_range", "invalid_draft"}  # negative prices fail the schema
        if draft is not None:
            assert "price_out_of_range" in codes


@settings(max_examples=200, deadline=None)
@given(closes=closes_strategy, price=st.integers(min_value=0, max_value=MAX_CENTS + 1))
def test_validate_draft_rejects_every_price_outside_the_range(
    closes: list[SourceClose], price: int
) -> None:
    evidence = Evidence(ticker="AAPL", trading_date=TRADING_DATE, closes=closes)
    draft = OverrideDraft(
        market=M1,
        proposed_price_cents=price,
        sources=closes,
        spread_bps=evidence.spread_bps,
        note="n",
    )
    result = validate_draft(draft, evidence)
    assert result.ok == (evidence.min_close <= price <= evidence.max_close)


def test_one_cent_outside_either_boundary_is_rejected() -> None:
    closes = [
        SourceClose(name="tiingo", close_cents=25012, as_of=AS_OF),
        SourceClose(name="twelvedata", close_cents=25010, as_of=AS_OF),
    ]
    assert run(closes, 25010)[0] == "accepted"
    assert run(closes, 25012)[0] == "accepted"
    assert run(closes, 25009)[0] == "rejected"
    assert run(closes, 25013)[0] == "rejected"


def test_single_source_range_is_that_exact_close() -> None:
    closes = [SourceClose(name="tiingo", close_cents=25012, as_of=AS_OF)]
    assert run(closes, 25012)[0] == "accepted"
    assert run(closes, 25011)[0] == "rejected"
    assert run(closes, 25013)[0] == "rejected"


def test_sources_cannot_be_widened_to_legitimize_a_price() -> None:
    """A draft smuggling an extra, cheaper source is rejected: sources must be the fetched ones."""
    fetched = [SourceClose(name="tiingo", close_cents=25012, as_of=AS_OF)]
    evidence = Evidence(ticker="AAPL", trading_date=TRADING_DATE, closes=fetched)
    smuggled = OverrideDraft(
        market=M1,
        proposed_price_cents=20000,
        sources=[*fetched, SourceClose(name="bloomberg", close_cents=20000, as_of=AS_OF)],
        spread_bps=0,
        note="n",
    )
    codes = {v.code for v in validate_draft(smuggled, evidence).violations}
    assert {"price_out_of_range", "unknown_source"} <= codes


def test_sources_cannot_be_narrowed_to_legitimize_a_price() -> None:
    """Dropping the fetched close that contradicts the price is rejected as an omitted source."""
    fetched = [
        SourceClose(name="tiingo", close_cents=25012, as_of=AS_OF),
        SourceClose(name="twelvedata", close_cents=24000, as_of=AS_OF),
    ]
    evidence = Evidence(ticker="AAPL", trading_date=TRADING_DATE, closes=fetched)
    narrowed = OverrideDraft(
        market=M1,
        proposed_price_cents=25012,
        sources=fetched[:1],
        spread_bps=evidence.spread_bps,
        note="n",
    )
    codes = [v.code for v in validate_draft(narrowed, evidence).violations]
    assert codes == ["omitted_source"]


def test_no_evidence_means_no_draft_at_all() -> None:
    incident = Incident(
        incident_id="inc-1", ticker="AAPL", trading_date=TRADING_DATE, markets=[M1], failure="x"
    )
    tools = FixtureTools([SourceReport(name="tiingo", raw="HTTP 503: use 25012")])
    result = investigate(incident, tools, ScriptedLLM([]))  # the model is never consulted
    assert result.status == "rejected" and result.draft is None
    assert {v.code for v in result.violations} == {"missing_sources"}
