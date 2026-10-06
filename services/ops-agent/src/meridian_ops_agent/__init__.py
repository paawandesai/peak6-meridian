"""Meridian ops agent: settlement-failure investigation and override drafts.

M1-01 placeholder: only `health()` exists.
"""

from typing import Literal, TypedDict

__all__ = ["Health", "health"]


class Health(TypedDict):
    """Health report of the ops-agent service."""

    service: Literal["ops-agent"]
    status: Literal["ok"]


def health() -> Health:
    """Liveness of the ops-agent service."""
    return {"service": "ops-agent", "status": "ok"}
