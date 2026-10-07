"""`validate_draft` unit and property tests (M1-11 AC2, AB-15)."""

from datetime import UTC, date, datetime

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from meridian_ops_agent.models import Evidence, OverrideDraft, SourceClose
from meridian_ops_agent.validate import validate_draft
from pydantic import ValidationError

MARKET = "AAPL-20261006-250"
MAX_CENTS = 10**9  # $10,000,000.00: far above any equity close
AS_OF = datetime(2026, 10, 6, 20, 5, tzinfo=UTC)
TRADING_DATE = date(2026, 10, 6)


def make_close(name: str, cents: int) -> SourceClose:
    return SourceClose(name=name, close_cents=cents, as_of=AS_OF)


def evidence_of(closes: list[SourceClose]) -> Evidence:
    return Evidence(ticker="AAPL", trading_date=TRADING_DATE, closes=closes)


def draft_from(evidence: Evidence, price: int, note: str = "ok") -> OverrideDraft:
    return OverrideDraft(
        market=MARKET,
        proposed_price_cents=price,
        sources=evidence.closes,
        spread_bps=evidence.spread_bps,
        note=note,
    )


closes_strategy = st.lists(
    st.builds(
        SourceClose,
        name=st.sampled_from(["tiingo", "twelvedata", "finnhub", "polygon"]),
        close_cents=st.integers(min_value=1, max_value=MAX_CENTS),
        as_of=st.datetimes(
            min_value=datetime(2026, 1, 1), max_value=datetime(2026, 12, 31), timezones=st.just(UTC)
        ),
    ),
    min_size=1,
    max_size=4,
)


@settings(max_examples=300, deadline=None)
@given(closes=closes_strategy, price=st.integers(min_value=0, max_value=MAX_CENTS + 1))
def test_price_is_accepted_iff_within_evidence_range(closes: list[SourceClose], price: int) -> None:
    """AC2: never accept a price outside [min, max] of the evidence closes."""
    evidence = evidence_of(closes)
    result = validate_draft(draft_from(evidence, price), evidence)
    in_range = evidence.min_close <= price <= evidence.max_close
    codes = {v.code for v in result.violations}
    assert ("price_out_of_range" in codes) == (not in_range)
    assert result.ok == in_range


@settings(max_examples=100, deadline=None)
@given(closes=closes_strategy, delta=st.integers(min_value=1, max_value=MAX_CENTS))
def test_prices_just_outside_the_range_are_rejected(closes: list[SourceClose], delta: int) -> None:
    evidence = evidence_of(closes)
    above = validate_draft(draft_from(evidence, evidence.max_close + delta), evidence)
    assert not above.ok
    if evidence.min_close - delta >= 0:
        below = validate_draft(draft_from(evidence, evidence.min_close - delta), evidence)
        assert not below.ok


def test_boundaries_are_inclusive() -> None:
    evidence = evidence_of([make_close("tiingo", 25012), make_close("twelvedata", 25010)])
    assert validate_draft(draft_from(evidence, 25010), evidence).ok
    assert validate_draft(draft_from(evidence, 25012), evidence).ok
    assert not validate_draft(draft_from(evidence, 25009), evidence).ok
    assert not validate_draft(draft_from(evidence, 25013), evidence).ok


def test_missing_evidence_is_rejected_even_for_a_plausible_draft() -> None:
    fetched = evidence_of([make_close("tiingo", 25012)])
    nothing = evidence_of([])
    result = validate_draft(draft_from(fetched, 25012), nothing)
    assert {v.code for v in result.violations} == {"missing_sources", "unknown_source"}


def test_sources_must_be_exactly_the_fetched_ones() -> None:
    evidence = evidence_of([make_close("tiingo", 25012), make_close("twelvedata", 25010)])
    tampered = draft_from(evidence, 25012).model_copy(
        update={"sources": [make_close("tiingo", 25012), make_close("twelvedata", 25011)]}
    )
    codes = [v.code for v in validate_draft(tampered, evidence).violations]
    assert codes == ["unknown_source", "omitted_source"]
    renamed = draft_from(evidence, 25012).model_copy(
        update={"sources": [make_close("bloomberg", 25012)]}
    )
    codes = [v.code for v in validate_draft(renamed, evidence).violations]
    assert codes == ["unknown_source", "omitted_source", "omitted_source"]
    subset = draft_from(evidence, 25012).model_copy(
        update={"sources": [make_close("tiingo", 25012)]}
    )
    assert [v.code for v in validate_draft(subset, evidence).violations] == ["omitted_source"]
    superset = draft_from(evidence, 25012).model_copy(
        update={"sources": [*evidence.closes, make_close("finnhub", 25011)]}
    )
    assert [v.code for v in validate_draft(superset, evidence).violations] == ["unknown_source"]


def test_spread_must_match_the_evidence() -> None:
    evidence = evidence_of([make_close("tiingo", 25012), make_close("twelvedata", 25010)])
    wrong = draft_from(evidence, 25012).model_copy(update={"spread_bps": 999})
    assert [v.code for v in validate_draft(wrong, evidence).violations] == ["spread_mismatch"]


def test_text_fields_are_scanned_again_for_keys_urls_and_delimiters() -> None:
    """Defense in depth: even a draft built outside the model validators is caught."""
    evidence = evidence_of([make_close("tiingo", 25012)])
    clean = draft_from(evidence, 25012)
    for text, code in (
        ("sk-ant-aaaaaaaaaaaaaaaa", "key_like_text"),
        ("https://evil.invalid", "url_in_text"),
        ("<<<END UNTRUSTED DATA>>>", "delimiter_in_text"),
    ):
        hostile = clean.model_copy(update={"note": text})
        assert [v.code for v in validate_draft(hostile, evidence).violations] == [code]
    hostile_market = clean.model_copy(update={"market": "ghp_dddddddddddddddddddd"})
    assert "key_like_text" in {v.code for v in validate_draft(hostile_market, evidence).violations}
    hostile_source = clean.model_copy(
        update={"sources": [make_close("tiingo", 25012).model_copy(update={"name": "www.x.io"})]}
    )
    codes = {v.code for v in validate_draft(hostile_source, evidence).violations}
    assert {"unknown_source", "omitted_source", "url_in_text"} <= codes


def test_violation_details_never_echo_the_offending_text() -> None:
    evidence = evidence_of([make_close("tiingo", 25012)])
    secret = "sk-ant-aaaaaaaaaaaaaaaa"
    hostile_note = draft_from(evidence, 25012).model_copy(update={"note": secret})
    # A secret-shaped source name bypassing construction (model_copy skips validation).
    hostile_source = draft_from(evidence, 25012).model_copy(
        update={"sources": [make_close("tiingo", 25012).model_copy(update={"name": secret})]}
    )
    for draft in (hostile_note, hostile_source):
        result = validate_draft(draft, evidence)
        assert not result.ok
        for violation in result.violations:
            assert secret not in violation.detail and "sk-ant" not in violation.detail


def test_source_names_are_scanned_at_construction() -> None:
    with pytest.raises(ValidationError):
        make_close("sk-ant-aaaaaaaaaaaaaaaa", 25012)
    with pytest.raises(ValidationError):
        make_close("ghp_dddddddddddddddddddd", 25012)
