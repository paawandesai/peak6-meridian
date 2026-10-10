import math
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from meridian_quant.vol import SIGMA_FLOOR, VolError, realized_vol


def closes_from_returns(returns: list[float]) -> list[Decimal]:
    out = [Decimal(100)]
    for r in returns:
        out.append(out[-1] * Decimal(str(math.exp(r))))
    return out


ALTERNATING = [0.03 if i % 2 == 0 else -0.03 for i in range(20)]  # stdev ~ 3.08% a day


def test_sigma_from_fixture_closes() -> None:
    sigma = realized_vol(closes_from_returns(ALTERNATING))
    mean = sum(ALTERNATING) / 20
    expected = math.sqrt(sum((r - mean) ** 2 for r in ALTERNATING) / 19) * math.sqrt(252)
    assert sigma == pytest.approx(expected, rel=1e-6)
    assert sigma > SIGMA_FLOOR


def test_flat_closes_floor_at_15_percent() -> None:
    assert realized_vol([Decimal(100)] * 21) == SIGMA_FLOOR


def test_only_the_last_20_returns_count() -> None:
    wild = [Decimal(1), Decimal(1000), Decimal(3)]
    calm = closes_from_returns(ALTERNATING)
    assert realized_vol([*wild, *calm]) == realized_vol(calm)


def test_missing_data_is_an_explicit_error_not_a_default() -> None:
    with pytest.raises(VolError, match="need 21"):
        realized_vol([Decimal(100)] * 20)
    with pytest.raises(VolError):
        realized_vol([])


def test_non_positive_close_is_rejected() -> None:
    bad = [Decimal(100)] * 20 + [Decimal(0)]
    with pytest.raises(VolError, match="positive"):
        realized_vol(bad)


@given(st.lists(st.floats(-0.2, 0.2), min_size=20, max_size=40))
def test_sigma_never_below_floor(returns: list[float]) -> None:
    assert realized_vol(closes_from_returns(returns)) >= SIGMA_FLOOR
