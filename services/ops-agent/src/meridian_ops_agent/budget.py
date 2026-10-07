"""Hard spend cap for the live model (`OPS_AGENT_BUDGET_USD`, D-025, brief.md § Budget).

Costs are `Decimal` dollars; token prices are the public per-million-token rates. The ledger
file makes the cap cumulative across runs, since the cap is for the whole week.
"""

from __future__ import annotations

import json
import os
from decimal import Decimal
from pathlib import Path

from meridian_ops_agent.models import StrictModel

__all__ = [
    "DEFAULT_MODEL",
    "Budget",
    "BudgetExhausted",
    "ModelPrice",
    "UnknownModelPrice",
    "price_for",
]

DEFAULT_MODEL = "claude-sonnet-5-5"
DEFAULT_BUDGET_USD = Decimal("20")
DEFAULT_LEDGER = Path.home() / ".cache" / "meridian" / "ops-agent-budget.json"
MTOK = Decimal(1_000_000)
# Approximation used only to refuse a call that could not fit the remaining budget.
CHARS_PER_TOKEN = 3


class ModelPrice(StrictModel):
    input_usd_per_mtok: Decimal
    output_usd_per_mtok: Decimal


_PRICES: dict[str, ModelPrice] = {
    "claude-sonnet-5-5": ModelPrice(input_usd_per_mtok=Decimal(2), output_usd_per_mtok=Decimal(10)),
    "claude-opus-5-5": ModelPrice(input_usd_per_mtok=Decimal(4), output_usd_per_mtok=Decimal(20)),
    "claude-haiku-4-5": ModelPrice(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(5)),
}


class UnknownModelPrice(ValueError):
    """Refuse to spend on a model whose price is not pinned here."""


class BudgetExhausted(RuntimeError):
    """The cap is reached; the caller must not call the model."""


def price_for(model: str) -> ModelPrice:
    try:
        return _PRICES[model]
    except KeyError as exc:
        raise UnknownModelPrice(f"no price pinned for model {model!r}") from exc


class Budget:
    """Tracks spend in USD against a hard limit, optionally persisted to a JSON ledger."""

    def __init__(self, limit_usd: Decimal, ledger: Path | None = None) -> None:
        if limit_usd < 0:
            raise ValueError("budget limit must be >= 0")
        self.limit_usd = limit_usd
        self.ledger = ledger
        self.spent_usd = self._load()

    @classmethod
    def from_env(cls, ledger: Path | None = DEFAULT_LEDGER) -> Budget:
        raw = os.environ.get("OPS_AGENT_BUDGET_USD", str(DEFAULT_BUDGET_USD))
        try:
            limit = Decimal(raw)
        except ArithmeticError as exc:
            raise ValueError(f"OPS_AGENT_BUDGET_USD is not a decimal number: {raw!r}") from exc
        return cls(limit, ledger)

    @property
    def remaining_usd(self) -> Decimal:
        return max(self.limit_usd - self.spent_usd, Decimal(0))

    def cost(self, model: str, input_tokens: int, output_tokens: int) -> Decimal:
        price = price_for(model)
        return (
            Decimal(input_tokens) * price.input_usd_per_mtok
            + Decimal(output_tokens) * price.output_usd_per_mtok
        ) / MTOK

    def ensure_affordable(self, model: str, prompt_chars: int, max_output_tokens: int) -> None:
        """Raise before a call whose worst case could cross the cap."""
        worst_case = self.cost(model, prompt_chars // CHARS_PER_TOKEN + 1, max_output_tokens)
        if self.spent_usd + worst_case > self.limit_usd:
            raise BudgetExhausted(
                f"spent {self.spent_usd} USD of {self.limit_usd}; next call could cost {worst_case}"
            )

    def charge(self, model: str, input_tokens: int, output_tokens: int) -> Decimal:
        """Record actual usage after a call; persist; return the cost."""
        cost = self.cost(model, input_tokens, output_tokens)
        self.spent_usd += cost
        self._save()
        return cost

    def _load(self) -> Decimal:
        if self.ledger is None or not self.ledger.exists():
            return Decimal(0)
        data = json.loads(self.ledger.read_text(encoding="utf-8"))
        return Decimal(str(data["spent_usd"]))

    def _save(self) -> None:
        if self.ledger is None:
            return
        self.ledger.parent.mkdir(parents=True, exist_ok=True)
        self.ledger.write_text(json.dumps({"spent_usd": str(self.spent_usd)}), encoding="utf-8")
