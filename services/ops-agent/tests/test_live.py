"""`AnthropicLLM` against a fake client object: no network, no key, no SDK client."""

from collections.abc import Iterable
from decimal import Decimal

import pytest
from anthropic.types import Message, MessageParam, TextBlock, ThinkingBlock, Usage
from meridian_ops_agent.budget import Budget, BudgetExhausted, UnknownModelPrice
from meridian_ops_agent.live import AnthropicLLM
from meridian_ops_agent.llm import LLMRequest


def message(text: str, stop_reason: str = "end_turn") -> Message:
    return Message.model_validate(
        {
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-5-5",
            "content": [
                ThinkingBlock(type="thinking", thinking="", signature="sig").model_dump(),
                TextBlock(type="text", text=text).model_dump(),
            ],
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "usage": Usage(input_tokens=1000, output_tokens=200).model_dump(),
        }
    )


class FakeMessages:
    def __init__(self, reply: Message) -> None:
        self.reply = reply
        self.calls: list[dict[str, object]] = []

    def create(
        self, *, model: str, max_tokens: int, system: str, messages: Iterable[MessageParam]
    ) -> Message:
        self.calls.append(
            {"model": model, "max_tokens": max_tokens, "system": system, "messages": list(messages)}
        )
        return self.reply


class FakeClient:
    def __init__(self, reply: Message) -> None:
        self._messages = FakeMessages(reply)

    @property
    def messages(self) -> FakeMessages:
        return self._messages


def test_complete_sends_system_and_user_and_charges_the_budget() -> None:
    client = FakeClient(message('{"market": "m"}'))
    budget = Budget(Decimal("20"))
    llm = AnthropicLLM(client, "claude-sonnet-5-5", budget)
    response = llm.complete(LLMRequest(system="SYS", user="USER", max_tokens=512))
    assert response.text == '{"market": "m"}'
    assert (response.input_tokens, response.output_tokens) == (1000, 200)
    assert response.stop_reason == "end_turn" and response.model == "claude-sonnet-5-5"
    assert budget.spent_usd == Decimal("0.004")
    call = client.messages.calls[0]
    assert call["model"] == "claude-sonnet-5-5" and call["max_tokens"] == 512
    assert call["system"] == "SYS"
    assert call["messages"] == [{"role": "user", "content": "USER"}]


def test_refusal_stop_reason_is_passed_through() -> None:
    llm = AnthropicLLM(FakeClient(message("", "refusal")), "claude-sonnet-5-5", Budget(Decimal(1)))
    assert llm.complete(LLMRequest(system="s", user="u")).stop_reason == "refusal"


def test_missing_stop_reason_defaults_to_end_turn() -> None:
    reply = message("x").model_copy(update={"stop_reason": None})
    llm = AnthropicLLM(FakeClient(reply), "claude-sonnet-5-5", Budget(Decimal(1)))
    assert llm.complete(LLMRequest(system="s", user="u")).stop_reason == "end_turn"


def test_exhausted_budget_blocks_the_call_before_it_is_made() -> None:
    client = FakeClient(message("x"))
    llm = AnthropicLLM(client, "claude-sonnet-5-5", Budget(Decimal("0")))
    with pytest.raises(BudgetExhausted):
        llm.complete(LLMRequest(system="s", user="u"))
    assert client.messages.calls == []


def test_unknown_model_fails_at_construction() -> None:
    with pytest.raises(UnknownModelPrice):
        AnthropicLLM(FakeClient(message("x")), "claude-mystery", Budget(Decimal(1)))


def test_from_env_reads_only_the_model_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPS_AGENT_MODEL", raising=False)
    assert (
        AnthropicLLM.from_env(FakeClient(message("x")), Budget(Decimal(1))).model
        == "claude-sonnet-5-5"
    )
    monkeypatch.setenv("OPS_AGENT_MODEL", "claude-haiku-4-5")
    assert (
        AnthropicLLM.from_env(FakeClient(message("x")), Budget(Decimal(1))).model
        == "claude-haiku-4-5"
    )
