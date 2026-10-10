"""Rate-limited warnings (M3-08b)."""

import logging

import pytest
from hypothesis import given
from hypothesis import strategies as st

from meridian_quant.ratelog import RateLimitedLog


def test_first_warning_is_loud_repeats_are_debug_until_the_interval(
    caplog: pytest.LogCaptureFixture,
) -> None:
    now = [0.0]
    rl = RateLimitedLog(logging.getLogger("t.rl"), 60, clock=lambda: now[0])
    with caplog.at_level(logging.DEBUG, logger="t.rl"):
        assert rl.warning("a", "first") is True
        now[0] = 59
        assert rl.warning("a", "repeat") is False
        assert rl.warning("b", "other key") is True
        now[0] = 60
        assert rl.warning("a", "again") is True
    levels = [(r.getMessage(), r.levelno) for r in caplog.records]
    assert levels == [
        ("first", logging.WARNING),
        ("repeat", logging.DEBUG),
        ("other key", logging.WARNING),
        ("again", logging.WARNING),
    ]


def test_clear_rearms_and_active_reports(caplog: pytest.LogCaptureFixture) -> None:
    rl = RateLimitedLog(logging.getLogger("t.rl2"), 60, clock=lambda: 0.0)
    assert rl.active("a") is False
    rl.log("a", "x", logging.INFO)
    assert rl.active("a") is True
    rl.clear("a")
    assert rl.active("a") is False
    with caplog.at_level(logging.INFO, logger="t.rl2"):
        assert rl.log("a", "y", logging.INFO) is True
    assert caplog.records[-1].levelno == logging.INFO


@given(st.lists(st.floats(min_value=0, max_value=30, allow_nan=False), max_size=50))
def test_loud_lines_are_at_least_an_interval_apart(gaps: list[float]) -> None:
    now = [0.0]
    loud_at: list[float] = []
    rl = RateLimitedLog(logging.getLogger("t.rl3"), 60, clock=lambda: now[0])
    for gap in gaps:
        now[0] += gap
        if rl.warning("k", "m"):
            loud_at.append(now[0])
    assert all(b - a >= 60 for a, b in zip(loud_at, loud_at[1:], strict=False))
