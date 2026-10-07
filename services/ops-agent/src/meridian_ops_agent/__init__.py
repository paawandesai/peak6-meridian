"""Meridian ops agent: settlement-failure investigation and override drafts (FR-27, NFR-11).

M1-11 ships the safety layer: boundary models, `validate_draft`, the `LLMClient` protocol with
a scripted fake, the read-only `investigate` skeleton and the eval harness. The service itself
(HTTP API, incident storage) arrives in M3.
"""

from typing import Literal, TypedDict

from meridian_ops_agent.agent import InvestigationResult, investigate
from meridian_ops_agent.llm import LLMClient, LLMRequest, LLMResponse, ScriptedLLM
from meridian_ops_agent.models import (
    Evidence,
    Incident,
    OverrideDraft,
    SourceClose,
    SourceReport,
    ValidationResult,
    Violation,
)
from meridian_ops_agent.tools import FixtureTools, ReadOnlyTools
from meridian_ops_agent.validate import validate_draft

__all__ = [
    "Evidence",
    "FixtureTools",
    "Health",
    "Incident",
    "InvestigationResult",
    "LLMClient",
    "LLMRequest",
    "LLMResponse",
    "OverrideDraft",
    "ReadOnlyTools",
    "ScriptedLLM",
    "SourceClose",
    "SourceReport",
    "ValidationResult",
    "Violation",
    "health",
    "investigate",
    "validate_draft",
]


class Health(TypedDict):
    """Health report of the ops-agent service."""

    service: Literal["ops-agent"]
    status: Literal["ok"]


def health() -> Health:
    """Liveness of the ops-agent service."""
    return {"service": "ops-agent", "status": "ok"}
