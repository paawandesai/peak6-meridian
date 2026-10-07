"""`LLMClient` protocol, a scripted fake for tests and evals, and a recording wrapper.

Tests and CI never talk to a real model (CLAUDE.md § Testing); `live.py` is the only
implementation that does.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from pydantic import Field

from meridian_ops_agent.models import StrictModel

__all__ = [
    "LLMClient",
    "LLMRequest",
    "LLMResponse",
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
