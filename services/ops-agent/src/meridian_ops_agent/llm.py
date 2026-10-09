"""`LLMClient` protocol, a scripted fake for tests and evals, and a recording wrapper.

Tests and CI never talk to a real model (CLAUDE.md § Testing); `live.py` is the only
implementation that does.
"""

from __future__ import annotations

import json
import logging
from typing import Protocol, runtime_checkable

from pydantic import Field

from meridian_ops_agent.budget import Budget
from meridian_ops_agent.models import StrictModel

__all__ = [
    "LLMClient",
    "LLMRequest",
    "LLMResponse",
    "LoggedLLM",
    "RecordingLLM",
    "ScriptExhausted",
    "ScriptedLLM",
]


class LLMRequest(StrictModel):
    system: str
    user: str
    max_tokens: int = Field(default=4096, gt=0)


class LLMResponse(StrictModel):
    text: str
    model: str
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    stop_reason: str = "end_turn"


@runtime_checkable
class LLMClient(Protocol):
    """One request, one response. Implementations hold no key material of their own."""

    def complete(self, request: LLMRequest) -> LLMResponse: ...


class ScriptExhausted(RuntimeError):
    """The scripted fake received more requests than it has responses for."""


class ScriptedLLM:
    """Replays fixed responses in order and records every request it was given."""

    model = "scripted-fake"

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.requests: list[LLMRequest] = []

    def complete(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        if not self._responses:
            raise ScriptExhausted(
                f"scripted LLM has no response left for request #{len(self.requests)}"
            )
        text = self._responses.pop(0)
        return LLMResponse(text=text, model=self.model, output_tokens=len(text) // 4)


class RecordingLLM:
    """Wraps any client and keeps the requests and responses that went through it."""

    def __init__(self, inner: LLMClient) -> None:
        self._inner = inner
        self.requests: list[LLMRequest] = []
        self.responses: list[LLMResponse] = []

    def complete(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        response = self._inner.complete(request)
        self.responses.append(response)
        return response


class LoggedLLM:
    """Logs one structured line per model call: tokens, cost and spend against the budget.

    Only numbers and the exception class name are logged, never prompts, replies or keys.
    The inner client charges the budget itself; this wrapper reads the result.
    """

    def __init__(self, inner: LLMClient, budget: Budget, log: logging.Logger | None = None) -> None:
        self._inner = inner
        self._budget = budget
        self._log = log or logging.getLogger("meridian_ops_agent.llm")

    def complete(self, request: LLMRequest) -> LLMResponse:
        try:
            response = self._inner.complete(request)
        except Exception as exc:
            self._emit({"event": "llm_call_failed", "error": type(exc).__name__})
            raise
        cost = self._budget.cost(response.model, response.input_tokens, response.output_tokens)
        self._emit(
            {
                "event": "llm_call",
                "model": response.model,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
                "cost_usd": str(cost),
            }
        )
        return response

    def _emit(self, fields: dict[str, str | int]) -> None:
        fields = {
            **fields,
            "spent_usd": str(self._budget.spent_usd),
            "remaining_usd": str(self._budget.remaining_usd),
            "limit_usd": str(self._budget.limit_usd),
        }
        self._log.info(json.dumps(fields, sort_keys=True))
