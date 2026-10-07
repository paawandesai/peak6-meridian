"""`validate_draft`: the last gate before a draft reaches a human (AB-15, NFR-11)."""

from __future__ import annotations

from meridian_ops_agent.models import (
    Evidence,
    OverrideDraft,
    ValidationResult,
    Violation,
    check_text_is_clean,
)

__all__ = ["validate_draft"]


def validate_draft(draft: OverrideDraft, evidence: Evidence) -> ValidationResult:
    """Reject a draft whose price leaves the evidence range, whose sources are missing, added
    or omitted relative to the fetched ones, or whose text looks like a key, a URL or a prompt
    delimiter.

    Pure and side-effect free; returns every violation found rather than the first.
    """
    violations: list[Violation] = []

    if not evidence.closes:
        violations.append(Violation(code="missing_sources", detail="no source close fetched"))
    else:
        low, high = evidence.min_close, evidence.max_close
        if not low <= draft.proposed_price_cents <= high:
            violations.append(
                Violation(
                    code="price_out_of_range",
                    detail=f"proposed {draft.proposed_price_cents} outside [{low}, {high}]",
                )
            )
        if draft.spread_bps != evidence.spread_bps:
            violations.append(
                Violation(
                    code="spread_mismatch",
                    detail=f"draft spread {draft.spread_bps} bps, evidence {evidence.spread_bps}",
                )
            )

    # Sources must be exactly the fetched closes: nothing added, nothing left out. Details carry
    # positions only, never names, since a name could itself be secret-shaped text.
    fetched = {(c.name, c.close_cents, c.as_of) for c in evidence.closes}
    listed = {(c.name, c.close_cents, c.as_of) for c in draft.sources}
    for index, source in enumerate(draft.sources):
        if (source.name, source.close_cents, source.as_of) not in fetched:
            violations.append(
                Violation(code="unknown_source", detail=f"sources[{index}] was not fetched")
            )
    for index, close in enumerate(evidence.closes):
        if (close.name, close.close_cents, close.as_of) not in listed:
            violations.append(
                Violation(code="omitted_source", detail=f"fetched close #{index} is not listed")
            )

    for field, text in (
        ("market", draft.market),
        ("note", draft.note),
        *((f"sources[{i}].name", s.name) for i, s in enumerate(draft.sources)),
    ):
        violations.extend(_text_violations(field, text))

    return ValidationResult(violations=violations)


def _text_violations(field: str, text: str) -> list[Violation]:
    try:
        check_text_is_clean(field, text)
    except ValueError as exc:
        message = str(exc)
        if "key-like" in message:
            return [Violation(code="key_like_text", detail=message)]
        if "URL" in message:
            return [Violation(code="url_in_text", detail=message)]
        return [Violation(code="delimiter_in_text", detail=message)]
    return []
