import math
from datetime import UTC, datetime
from decimal import Decimal
from statistics import NormalDist

import pytest
from hypothesis import given
from hypothesis import strategies as st
from meridian_quant.fair_value import (
    SESSION_SECONDS_PER_YEAR,
    FairValueError,
    fair_cents,
    fair_probability,
    remaining_session_seconds,
)

# (spot $, strike cents, sigma, remaining seconds): reference computed with statistics.NormalDist,
# a different implementation from the module's erf.
GOLDEN = [
    (Decimal("181.42"), 18_000, 0.30, 3 * 3600),
    (Decimal("181.42"), 19_000, 0.30, 3 * 3600),
    (Decimal("100.00"), 10_000, 0.15, 6 * 3600 + 1800),
    (Decimal("250.10"), 24_000, 0.45, 600),
    (Decimal("50.00"), 55_000, 0.60, 5 * 3600),
]


def reference_cents(spot: Decimal, strike_cents: int, sigma: float, secs: int) -> float:
    t = secs / (252 * 6.5 * 3600)
    d2 = (math.log(float(spot) / (strike_cents / 100)) - sigma**2 * t / 2) / (sigma * math.sqrt(t))
    return NormalDist().cdf(d2) * 100


@pytest.mark.parametrize(("spot", "strike", "sigma", "secs"), GOLDEN)
def test_golden_values_match_reference_within_one_cent(
    spot: Decimal, strike: int, sigma: float, secs: int
) -> None:
    expected = min(99, max(1, round(reference_cents(spot, strike, sigma, secs))))
    assert abs(fair_cents(spot, strike, sigma, secs) - expected) <= 1


def test_session_year_constant() -> None:
    assert SESSION_SECONDS_PER_YEAR == 252 * 6.5 * 3600


@given(
    spot=st.decimals(min_value="1", max_value="1000", places=2),
    strikes=st.lists(st.integers(100, 200_000), min_size=2, max_size=8),
    sigma=st.floats(0.15, 2.0),
    secs=st.integers(1, 6 * 3600 + 1800),
)
def test_fair_is_bounded_and_non_increasing_in_strike(
    spot: Decimal, strikes: list[int], sigma: float, secs: int
) -> None:
    values = [fair_cents(spot, k, sigma, secs) for k in sorted(strikes)]
    assert all(1 <= v <= 99 for v in values)
    assert values == sorted(values, reverse=True)


@given(
    spot=st.decimals(min_value="1", max_value="1000", places=2),
    strike=st.integers(100, 200_000),
    sigma=st.floats(0.15, 2.0),
)
def test_expiry_limit_matches_step_function(spot: Decimal, strike: int, sigma: float) -> None:
    step = 99 if spot >= Decimal(strike) / 100 else 1
    assert fair_cents(spot, strike, sigma, 0) == step
    assert fair_cents(spot, strike, sigma, -5) == step
    # One second before the close, away from the strike, is already the step.
    if abs(spot - Decimal(strike) / 100) / spot > Decimal("0.05"):
        assert fair_cents(spot, strike, sigma, 1) == step


def test_at_the_money_is_about_even() -> None:
    assert fair_cents(Decimal("100"), 10_000, 0.2, 3600) in (49, 50)


def test_invalid_inputs_raise() -> None:
    with pytest.raises(FairValueError):
        fair_probability(Decimal(0), 100, 0.2, 60)
    with pytest.raises(FairValueError):
        fair_probability(Decimal(1), 0, 0.2, 60)
    for bad in (0.0, -1.0, math.nan, math.inf):
        with pytest.raises(FairValueError):
            fair_probability(Decimal(1), 100, bad, 60)


def ts(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp())


def test_remaining_session_seconds() -> None:
    close = ts("2026-10-08T20:00:00+00:00")  # 16:00 EDT
    assert (
        remaining_session_seconds(datetime.fromisoformat("2026-10-08T19:00:00+00:00"), close)
        == 3600
    )
    assert remaining_session_seconds(
        datetime.fromisoformat("2026-10-08T12:00:00+00:00"), close
    ) == int(6.5 * 3600)
    assert (
        remaining_session_seconds(datetime.fromisoformat("2026-10-08T20:00:00+00:00"), close) == 0
    )
    assert (
        remaining_session_seconds(datetime.fromisoformat("2026-10-08T21:00:00+00:00"), close) == 0
    )
    # Early close at 13:00 EST (DST over): session is 09:30-13:00.
    early = ts("2026-11-27T18:00:00+00:00")
    assert remaining_session_seconds(
        datetime.fromisoformat("2026-11-27T10:00:00+00:00"), early
    ) == int(3.5 * 3600)
    with pytest.raises(FairValueError):
        remaining_session_seconds(datetime(2026, 10, 8), close)
    assert remaining_session_seconds(datetime(2026, 10, 8, tzinfo=UTC), close) == int(6.5 * 3600)
