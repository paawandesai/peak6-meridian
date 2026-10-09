"""Meridian quant service: fair-value engine and market maker.

M1-01 placeholder: only `health()` exists.
"""

from typing import TYPE_CHECKING, Literal, TypedDict

if TYPE_CHECKING:
    from meridian_quant.mm.loop import MarketMakerLoop

__all__ = ["Health", "health"]


class Health(TypedDict, total=False):
    """Health report of the quant service."""

    service: Literal["quant"]
    status: Literal["ok"]
    book_coverage: float  # Optional: present only when MM loop is running


def health(mm_loop: "MarketMakerLoop | None" = None) -> Health:
    """Liveness of the quant service.

    Args:
        mm_loop: Optional MM loop instance to include book_coverage metric

    Returns:
        Health report with service status and optional book_coverage
    """
    result: Health = {"service": "quant", "status": "ok"}
    if mm_loop is not None:
        result["book_coverage"] = mm_loop.book_coverage
    return result
