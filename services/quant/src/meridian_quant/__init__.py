"""Meridian quant service: fair-value engine and market maker.

M1-01 placeholder: only `health()` exists.
"""

from typing import Literal, TypedDict

__all__ = ["Health", "health"]


class Health(TypedDict):
    """Health report of the quant service."""

    service: Literal["quant"]
    status: Literal["ok"]


def health() -> Health:
    """Liveness of the quant service."""
    return {"service": "quant", "status": "ok"}
