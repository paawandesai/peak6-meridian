"""Pydantic boundary models of the ops agent (architecture.md § Interfaces, NFR-11).

Money is integer cents; dates are ET calendar dates; timestamps are timezone-aware.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from meridian_ops_agent.textcheck import contains_delimiter, contains_url, looks_like_key

__all__ = [
    "NOTE_MAX_CHARS",
    "Evidence",
    "Ident",
    "Incident",
    "LLMDraft",
    "OverrideDraft",
    "SourceClose",
    "SourceReport",
    "StrictModel",
    "Ticker",
    "ValidationResult",
    "Violation",
    "ViolationCode",
    "check_text_is_clean",
    "spread_bps",
]

NOTE_MAX_CHARS = 2000
FAILURE_MAX_CHARS = 10_000
BPS = 10_000

# Identifiers (market PDAs in base58, source names, incident ids): no whitespace, no URLs.
Ident = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
Ticker = Annotated[str, Field(pattern=r"^[A-Z]{1,5}$")]

ViolationCode = Literal[
    "llm_refusal",
    "unparseable_output",
    "no_price_proposed",
    "market_not_in_incident",
    "invalid_draft",
    "missing_sources",
    "unknown_source",
    "omitted_source",
    "price_out_of_range",
    "spread_mismatch",
    "key_like_text",
    "url_in_text",
    "delimiter_in_text",
]


class StrictModel(BaseModel):
    """Base for every boundary model: unknown fields rejected, instances immutable."""

    model_config = ConfigDict(extra="forbid", frozen=True)


def check_text_is_clean(field: str, text: str) -> None:
    """Raise ``ValueError`` when ``text`` carries a URL, a key-like token or a block delimiter."""
    if (description := looks_like_key(text)) is not None:
        raise ValueError(f"{field} contains a key-like token ({description})")
    if contains_url(text):
        raise ValueError(f"{field} contains a URL")
    if contains_delimiter(text):
        raise ValueError(f"{field} contains an untrusted-data delimiter")


def spread_bps(closes: list[int]) -> int:
    """Spread between the lowest and highest close in basis points of the lowest close."""
    low, high = min(closes), max(closes)
    return (high - low) * BPS // low


class SourceClose(StrictModel):
    """One data source's official daily close, in whole cents."""

    name: Ident
    close_cents: int = Field(gt=0)
    as_of: AwareDatetime

    @field_validator("name")
    @classmethod
    def _name_is_clean(cls, value: str) -> str:
        check_text_is_clean("source name", value)
        return value


class SourceReport(StrictModel):
    """What a read-only tool returned for one source: the parsed close (if any) plus raw text.

    ``raw`` is untrusted (API body, error message, log line) and only ever reaches the model
    inside an untrusted-data block.
    """

    name: Ident
    close: SourceClose | None = None
    raw: str = Field(default="", max_length=FAILURE_MAX_CHARS)

    @model_validator(mode="after")
    def _close_matches_name(self) -> SourceReport:
        if self.close is not None and self.close.name != self.name:
            raise ValueError("close.name must equal the report name")
        return self


class Evidence(StrictModel):
    """Every close the tools could fetch for one ticker and trading date."""

    ticker: Ticker
    trading_date: date
    closes: list[SourceClose] = Field(default_factory=list)

    @property
    def min_close(self) -> int:
        return min(c.close_cents for c in self.closes)

    @property
    def max_close(self) -> int:
        return max(c.close_cents for c in self.closes)

    @property
    def spread_bps(self) -> int:
        return spread_bps([c.close_cents for c in self.closes])


class Incident(StrictModel):
    """A settlement failure posted by `automation` (architecture.md: POST /incidents)."""

    incident_id: Ident
    ticker: Ticker
    trading_date: date
    markets: list[Ident] = Field(min_length=1)
    failure: str = Field(max_length=FAILURE_MAX_CHARS)  # untrusted free text


class LLMDraft(BaseModel):
    """The only shape the model may answer with. Anything else is an unparseable output."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    market: str = Field(max_length=256)
    proposed_price_cents: int | None = None
    note: str = Field(default="", max_length=4 * NOTE_MAX_CHARS)


class OverrideDraft(StrictModel):
    """An admin override proposal: evidence-backed, human-approved, never signed here."""

    market: Ident
    proposed_price_cents: int = Field(ge=0)
    sources: list[SourceClose] = Field(min_length=1)
    spread_bps: int = Field(ge=0)
    note: str = Field(max_length=NOTE_MAX_CHARS)

    @field_validator("market")
    @classmethod
    def _market_is_clean(cls, value: str) -> str:
        check_text_is_clean("market", value)
        return value

    @field_validator("note")
    @classmethod
    def _note_is_clean(cls, value: str) -> str:
        check_text_is_clean("note", value)
        return value


class Violation(StrictModel):
    """Why a draft was rejected. ``detail`` never echoes untrusted text."""

    code: ViolationCode
    detail: str = Field(max_length=500)


class ValidationResult(StrictModel):
    violations: list[Violation] = Field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.violations
