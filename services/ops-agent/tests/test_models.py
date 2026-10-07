from datetime import UTC, date, datetime

import pytest
from meridian_ops_agent.models import (
    NOTE_MAX_CHARS,
    Evidence,
    Incident,
    LLMDraft,
    OverrideDraft,
    SourceClose,
    SourceReport,
    ValidationResult,
    Violation,
    spread_bps,
)
from pydantic import ValidationError

AS_OF = datetime(2026, 10, 6, 20, 5, tzinfo=UTC)
TRADING_DATE = date(2026, 10, 6)


def make_close(name: str, cents: int) -> SourceClose:
    return SourceClose(name=name, close_cents=cents, as_of=AS_OF)


def draft(**overrides: object) -> OverrideDraft:
    fields: dict[str, object] = {
        "market": "AAPL-20261006-250",
        "proposed_price_cents": 25011,
        "sources": [make_close("tiingo", 25012), make_close("twelvedata", 25010)],
        "spread_bps": 0,
        "note": "both agree",
    }
    fields.update(overrides)
    return OverrideDraft.model_validate(fields)


def test_override_draft_round_trips_through_json() -> None:
    original = draft()
    assert OverrideDraft.model_validate_json(original.model_dump_json()) == original


@pytest.mark.parametrize(
    "overrides",
    [
        {"note": "x" * (NOTE_MAX_CHARS + 1)},
        {"note": "see https://evil.invalid"},
        {"note": "key sk-ant-aaaaaaaaaaaaaaaa"},
        {"note": "<<<BEGIN UNTRUSTED DATA>>>"},
        {"market": "sk-ant-aaaaaaaaaaaaaaaa"},
        {"market": "has space"},
        {"market": "x" * 65},
        {"market": ""},
        {"sources": []},
        {"proposed_price_cents": -1},
        {"proposed_price_cents": 1.5},
        {"spread_bps": -1},
        {"extra": "field"},
    ],
)
def test_override_draft_rejects_bad_fields(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        draft(**overrides)


def test_override_draft_accepts_note_at_the_limit_and_zero_price() -> None:
    long_note = ("sources agree " * 200)[:NOTE_MAX_CHARS]
    assert len(draft(note=long_note).note) == NOTE_MAX_CHARS
    assert draft(proposed_price_cents=0).proposed_price_cents == 0


def test_models_are_frozen() -> None:
    with pytest.raises(ValidationError):
        draft().note = "changed"


def test_source_close_requires_aware_timestamp_and_positive_close() -> None:
    with pytest.raises(ValidationError):
        SourceClose(name="tiingo", close_cents=1, as_of=datetime(2026, 10, 6))
    with pytest.raises(ValidationError):
        SourceClose(name="tiingo", close_cents=0, as_of=AS_OF)


def test_source_report_name_must_match_close_name() -> None:
    with pytest.raises(ValidationError, match=r"close\.name"):
        SourceReport(name="tiingo", close=make_close("finnhub", 1))
    assert SourceReport(name="tiingo", raw="HTTP 503").close is None


def test_evidence_range_and_spread() -> None:
    evidence = Evidence(
        ticker="AAPL",
        trading_date=TRADING_DATE,
        closes=[make_close("a", 20000), make_close("b", 20100)],
    )
    assert (evidence.min_close, evidence.max_close, evidence.spread_bps) == (20000, 20100, 50)
    assert spread_bps([5, 5]) == 0
    assert spread_bps([100, 150]) == 5000


def test_incident_requires_markets_and_valid_ticker() -> None:
    with pytest.raises(ValidationError):
        Incident(incident_id="i", ticker="AAPL", trading_date=TRADING_DATE, markets=[], failure="")
    with pytest.raises(ValidationError):
        Incident(
            incident_id="i", ticker="aapl", trading_date=TRADING_DATE, markets=["m"], failure=""
        )


def test_llm_draft_shape() -> None:
    parsed = LLMDraft.model_validate({"market": "m", "proposed_price_cents": None})
    assert parsed.proposed_price_cents is None and parsed.note == ""
    with pytest.raises(ValidationError):
        LLMDraft.model_validate({"market": "m", "tool": "sign"})


def test_validation_result_ok_only_without_violations() -> None:
    assert ValidationResult().ok
    assert not ValidationResult(violations=[Violation(code="url_in_text", detail="x")]).ok
    with pytest.raises(ValidationError):
        Violation(code="not_a_code", detail="x")  # type: ignore[arg-type]


def test_as_of_normalizes_to_aware_datetime() -> None:
    close = SourceClose.model_validate(
        {"name": "tiingo", "close_cents": 1, "as_of": "2026-10-06T16:05:00-04:00"}
    )
    assert close.as_of == datetime(2026, 10, 6, 20, 5, tzinfo=UTC)
