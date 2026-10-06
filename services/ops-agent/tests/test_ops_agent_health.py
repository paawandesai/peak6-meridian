from meridian_ops_agent import health


def test_health_reports_ops_agent_ok() -> None:
    assert health() == {"service": "ops-agent", "status": "ok"}
