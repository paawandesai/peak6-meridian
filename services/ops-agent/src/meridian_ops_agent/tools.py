"""Read-only tools the agent may use, and the policy that keeps them read-only (AB-20).

The agent never receives a tool that writes, signs, sends or fetches arbitrary URLs. The
allowlist below is the whole tool surface; `assert_read_only` refuses any object exposing more.
"""

from __future__ import annotations

from datetime import date
from typing import Protocol

from meridian_ops_agent.models import SourceReport

__all__ = [
    "READ_ONLY_TOOL_NAMES",
    "FixtureTools",
    "ReadOnlyTools",
    "ToolPolicyError",
    "assert_read_only",
]

READ_ONLY_TOOL_NAMES: frozenset[str] = frozenset({"source_closes", "settlement_log"})


class ReadOnlyTools(Protocol):
    def source_closes(self, ticker: str, trading_date: date) -> list[SourceReport]:
        """Latest official daily close per data source, plus the raw response text."""
        ...

    def settlement_log(self, incident_id: str) -> str:
        """Automation's log lines for the failed settlement attempts (untrusted text)."""
        ...


class ToolPolicyError(PermissionError):
    """The tools object exposes something outside the read-only allowlist."""


def assert_read_only(tools: object) -> None:
    """Fail loudly if ``tools`` has any public callable that is not an allowlisted read tool."""
    exposed = {
        name
        for name in dir(tools)
        if not name.startswith("_") and callable(getattr(tools, name, None))
    }
    extra = exposed - READ_ONLY_TOOL_NAMES
    if extra:
        raise ToolPolicyError(f"tools expose non-allowlisted callables: {sorted(extra)}")
    missing = READ_ONLY_TOOL_NAMES - exposed
    if missing:
        raise ToolPolicyError(f"tools are missing read tools: {sorted(missing)}")


class FixtureTools:
    """Tools backed by fixed data: used by tests, evals and the local demo (D-033)."""

    def __init__(self, reports: list[SourceReport], log: str = "") -> None:
        self._reports = list(reports)
        self._log = log
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def source_closes(self, ticker: str, trading_date: date) -> list[SourceReport]:
        self.calls.append(("source_closes", (ticker, trading_date)))
        return list(self._reports)

    def settlement_log(self, incident_id: str) -> str:
        self.calls.append(("settlement_log", (incident_id,)))
        return self._log
