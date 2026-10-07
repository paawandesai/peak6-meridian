from decimal import Decimal
from pathlib import Path

import pytest
from meridian_ops_agent.budget import (
    DEFAULT_MODEL,
    Budget,
    BudgetExhausted,
    UnknownModelPrice,
    price_for,
)


def test_cost_uses_pinned_per_million_prices() -> None:
    budget = Budget(Decimal("20"))
    assert budget.cost("claude-sonnet-5-5", 1_000_000, 1_000_000) == Decimal("12")
    assert budget.cost("claude-opus-5-5", 500_000, 0) == Decimal("2")
    assert budget.cost("claude-haiku-4-5", 0, 200_000) == Decimal("1")
    assert price_for(DEFAULT_MODEL).input_usd_per_mtok == Decimal(2)


def test_unknown_model_is_refused_before_spending() -> None:
    with pytest.raises(UnknownModelPrice):
        Budget(Decimal("20")).cost("claude-unknown", 1, 1)


def test_charge_accumulates_and_remaining_never_goes_negative() -> None:
    budget = Budget(Decimal("0.01"))
    assert budget.charge("claude-sonnet-5-5", 1000, 1000) == Decimal("0.012")
    assert budget.spent_usd == Decimal("0.012")
    assert budget.remaining_usd == Decimal("0")


def test_ensure_affordable_refuses_a_call_that_could_cross_the_cap() -> None:
    budget = Budget(Decimal("0.001"))
    budget.ensure_affordable("claude-sonnet-5-5", prompt_chars=30, max_output_tokens=10)
    with pytest.raises(BudgetExhausted, match="could cost"):
        budget.ensure_affordable("claude-sonnet-5-5", prompt_chars=30, max_output_tokens=1000)
    budget.charge("claude-sonnet-5-5", 100, 100)
    with pytest.raises(BudgetExhausted):
        budget.ensure_affordable("claude-sonnet-5-5", prompt_chars=3, max_output_tokens=1)


def test_ledger_persists_spend_across_instances(tmp_path: Path) -> None:
    ledger = tmp_path / "nested" / "budget.json"
    first = Budget(Decimal("20"), ledger)
    first.charge("claude-sonnet-5-5", 1_000_000, 0)
    second = Budget(Decimal("20"), ledger)
    assert second.spent_usd == Decimal("2")
    assert '"spent_usd": "2"' in ledger.read_text(encoding="utf-8")


def test_from_env_reads_the_cap(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("OPS_AGENT_BUDGET_USD", raising=False)
    assert Budget.from_env(tmp_path / "l.json").limit_usd == Decimal("20")
    monkeypatch.setenv("OPS_AGENT_BUDGET_USD", "3.50")
    assert Budget.from_env(None).limit_usd == Decimal("3.50")
    monkeypatch.setenv("OPS_AGENT_BUDGET_USD", "lots")
    with pytest.raises(ValueError, match="not a decimal"):
        Budget.from_env(None)


def test_negative_limit_is_rejected() -> None:
    with pytest.raises(ValueError):
        Budget(Decimal("-1"))
