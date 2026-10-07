"""The real Anthropic client behind `LLMClient`. Never imported by tests or CI paths.

The API key is read by the SDK itself from `ANTHROPIC_API_KEY`; this module never touches it,
never logs it and never places it in a prompt (threat-model.md AB-20).
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from typing import Protocol

from anthropic.types import Message, MessageParam

from meridian_ops_agent.budget import DEFAULT_MODEL, Budget, price_for
from meridian_ops_agent.llm import LLMRequest, LLMResponse

__all__ = ["AnthropicClientLike", "AnthropicLLM"]


class _MessagesLike(Protocol):
    def create(
        self, *, model: str, max_tokens: int, system: str, messages: Iterable[MessageParam]
    ) -> Message: ...


class AnthropicClientLike(Protocol):
    """The slice of `anthropic.Anthropic` the agent uses; tests pass a fake."""

    @property
    def messages(self) -> _MessagesLike: ...


class AnthropicLLM:
    def __init__(self, client: AnthropicClientLike, model: str, budget: Budget) -> None:
        price_for(model)  # fail before the first call if the model's price is unknown
        self._client = client
        self.model = model
        self.budget = budget

    @classmethod
    def from_env(cls, client: AnthropicClientLike, budget: Budget) -> AnthropicLLM:
        return cls(client, os.environ.get("OPS_AGENT_MODEL", DEFAULT_MODEL), budget)

    def complete(self, request: LLMRequest) -> LLMResponse:
        self.budget.ensure_affordable(
            self.model, len(request.system) + len(request.user), request.max_tokens
        )
        message = self._client.messages.create(
            model=self.model,
            max_tokens=request.max_tokens,
            system=request.system,
            messages=[{"role": "user", "content": request.user}],
        )
        self.budget.charge(self.model, message.usage.input_tokens, message.usage.output_tokens)
        text = "".join(block.text for block in message.content if block.type == "text")
        return LLMResponse(
            text=text,
            model=message.model,
            input_tokens=message.usage.input_tokens,
            output_tokens=message.usage.output_tokens,
            stop_reason=message.stop_reason or "end_turn",
        )
