from meridian_quant import health


def test_health_reports_quant_ok() -> None:
    assert health() == {"service": "quant", "status": "ok"}
