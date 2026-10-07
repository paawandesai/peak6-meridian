"""`investigate`: read-only evidence gathering, one model call, schema + range validation.

Skeleton for M3 (FR-27). The model's output is a *proposal*; nothing here signs, submits or
approves (D-021, D-025). The agent fills ``sources`` and ``spread_bps`` from the evidence it
fetched itself; the model only proposes a market, a price and a note.
"""

from __future__ import annotations

import json
from typing import Literal

from pydantic import Field, ValidationError

from meridian_ops_agent.llm import LLMClient, LLMRequest
from meridian_ops_agent.models import (
    Evidence,
    Incident,
    LLMDraft,
    OverrideDraft,
    StrictModel,
    Violation,
)
from meridian_ops_agent.prompt import build_prompt
from meridian_ops_agent.tools import ReadOnlyTools, assert_read_only
from meridian_ops_agent.validate import validate_draft

__all__ = ["InvestigationResult", "investigate", "parse_llm_draft"]


class InvestigationResult(StrictModel):
    incident_id: str
    status: Literal["accepted", "rejected"]
    draft: OverrideDraft | None = None
    violations: list[Violation] = Field(default_factory=list)
    evidence: Evidence
    llm_called: bool


def investigate(incident: Incident, tools: ReadOnlyTools, llm: LLMClient) -> InvestigationResult:
    """Gather evidence through read-only tools, ask the model once, validate what came back."""
    assert_read_only(tools)
    reports = tools.source_closes(incident.ticker, incident.trading_date)
    log = tools.settlement_log(incident.incident_id)
    evidence = Evidence(
        ticker=incident.ticker,
        trading_date=incident.trading_date,
        closes=[report.close for report in reports if report.close is not None],
    )
    if not evidence.closes:
        # Nothing to draft from, so there is nothing to ask the model about.
        return InvestigationResult(
            incident_id=incident.incident_id,
            status="rejected",
            violations=[Violation(code="missing_sources", detail="every source failed")],
            evidence=evidence,
            llm_called=False,
        )

    prompt = build_prompt(incident, evidence, reports, log)
    response = llm.complete(LLMRequest(system=prompt.system, user=prompt.user))

    violations: list[Violation] = []
    draft: OverrideDraft | None = None
    if response.stop_reason == "refusal":
        violations.append(Violation(code="llm_refusal", detail="model declined the request"))
    else:
        parsed = parse_llm_draft(response.text)
        if isinstance(parsed, Violation):
            violations.append(parsed)
        else:
            draft, violations = _build_draft(parsed, incident, evidence)

    return InvestigationResult(
        incident_id=incident.incident_id,
        status="accepted" if not violations else "rejected",
        draft=draft,
        violations=violations,
        evidence=evidence,
        llm_called=True,
    )


def parse_llm_draft(text: str) -> LLMDraft | Violation:
    """Parse the model's reply as a single JSON object of the `LLMDraft` shape."""
    candidate = text.strip()
    start, end = candidate.find("{"), candidate.rfind("}")
    if start == -1 or end <= start:
        return Violation(code="unparseable_output", detail="no JSON object in the reply")
    try:
        payload = json.loads(candidate[start : end + 1])
    except json.JSONDecodeError as exc:
        return Violation(code="unparseable_output", detail=f"invalid JSON at offset {exc.pos}")
    try:
        return LLMDraft.model_validate(payload)
    except ValidationError as exc:
        return Violation(code="unparseable_output", detail=_describe(exc))


def _build_draft(
    parsed: LLMDraft, incident: Incident, evidence: Evidence
) -> tuple[OverrideDraft | None, list[Violation]]:
    violations: list[Violation] = []
    if parsed.proposed_price_cents is None:
        violations.append(Violation(code="no_price_proposed", detail="model proposed no price"))
        return None, violations
    if parsed.market not in incident.markets:
        violations.append(
            Violation(code="market_not_in_incident", detail="market is not one of the incident's")
        )
    try:
        draft = OverrideDraft(
            market=parsed.market,
            proposed_price_cents=parsed.proposed_price_cents,
            sources=evidence.closes,
            spread_bps=evidence.spread_bps,
            note=parsed.note,
        )
    except ValidationError as exc:
        violations.append(Violation(code="invalid_draft", detail=_describe(exc)))
        return None, violations
    violations.extend(validate_draft(draft, evidence).violations)
    return draft, violations


def _describe(exc: ValidationError) -> str:
    """Field and error type only: pydantic's messages can echo the offending input."""
    parts = sorted({".".join(str(p) for p in e["loc"]) + ":" + e["type"] for e in exc.errors()})
    return "; ".join(parts)[:500]
