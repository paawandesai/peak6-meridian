import pytest
from meridian_ops_agent.llm import (
    LLMClient,
    LLMRequest,
    LLMResponse,
    RecordingLLM,
    ScriptedLLM,
    ScriptExhausted,
)


def test_scripted_llm_replays_in_order_and_records_requests() -> None:
    llm = ScriptedLLM(["one", "two"])
    first = llm.complete(LLMRequest(system="s", user="u1"))
    second = llm.complete(LLMRequest(system="s", user="u2"))
    assert (first.text, second.text) == ("one", "two")
    assert first.model == "scripted-fake" and first.stop_reason == "end_turn"
    assert [r.user for r in llm.requests] == ["u1", "u2"]


def test_scripted_llm_fails_loudly_when_exhausted() -> None:
    llm = ScriptedLLM([])
    with pytest.raises(ScriptExhausted, match="request #1"):
        llm.complete(LLMRequest(system="s", user="u"))


def test_scripted_llm_satisfies_the_protocol() -> None:
    assert isinstance(ScriptedLLM([]), LLMClient)
    assert not isinstance(object(), LLMClient)


def test_recording_llm_passes_through_and_keeps_both_sides() -> None:
    inner = ScriptedLLM(["reply"])
    recorder = RecordingLLM(inner)
    response = recorder.complete(LLMRequest(system="s", user="u"))
    assert response == LLMResponse(text="reply", model="scripted-fake", output_tokens=1)
    assert recorder.requests == inner.requests
    assert recorder.responses == [response]


def test_request_requires_positive_max_tokens() -> None:
    with pytest.raises(ValueError):
        LLMRequest(system="s", user="u", max_tokens=0)
    assert LLMRequest(system="s", user="u").max_tokens == 4096
