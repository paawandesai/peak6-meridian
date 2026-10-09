"""JSON file store for incidents and their drafts, on the service's volume (architecture.md).

One file, replaced atomically on every write. It holds public data only: incident text (which
is untrusted and only ever read back as data), per-source closes and validated drafts.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Literal

from pydantic import Field, ValidationError

from meridian_ops_agent.agent import InvestigationResult
from meridian_ops_agent.models import Incident, OverrideDraft, SourceClose, StrictModel

__all__ = ["DraftView", "IncidentRecord", "IncidentStore", "StoreCorrupt"]


class StoreCorrupt(RuntimeError):
    """The store file exists but is not valid; refuse to overwrite it."""


class IncidentRecord(StrictModel):
    incident: Incident
    status: Literal["pending", "accepted", "rejected"] = "pending"
    result: InvestigationResult | None = None


class _SourceView(StrictModel):
    name: str
    close: int
    as_of: str


class DraftView(StrictModel):
    """The `GET /drafts` item shape from architecture.md."""

    incident_id: str
    market: str
    proposed_price_cents: int
    sources: list[_SourceView]
    spread_bps: int
    note: str
    status: Literal["pending_approval"] = "pending_approval"
    fallback: bool = False


class _File(StrictModel):
    incidents: dict[str, IncidentRecord] = Field(default_factory=dict)


def _sources(closes: list[SourceClose]) -> list[_SourceView]:
    return [
        _SourceView(name=c.name, close=c.close_cents, as_of=c.as_of.isoformat()) for c in closes
    ]


def _view(incident_id: str, draft: OverrideDraft, fallback: bool) -> DraftView:
    return DraftView(
        incident_id=incident_id,
        market=draft.market,
        proposed_price_cents=draft.proposed_price_cents,
        sources=_sources(draft.sources),
        spread_bps=draft.spread_bps,
        note=draft.note,
        fallback=fallback,
    )


class IncidentStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()

    def add(self, incident: Incident) -> bool:
        """Store a new incident as pending. False (and no change) if the id already exists."""
        with self._lock:
            data = self._read()
            if incident.incident_id in data.incidents:
                return False
            data.incidents[incident.incident_id] = IncidentRecord(incident=incident)
            self._write(data)
            return True

    def complete(self, result: InvestigationResult) -> None:
        with self._lock:
            data = self._read()
            record = data.incidents.get(result.incident_id)
            if record is None:
                raise KeyError(result.incident_id)
            data.incidents[result.incident_id] = record.model_copy(
                update={"status": result.status, "result": result}
            )
            self._write(data)

    def get(self, incident_id: str) -> IncidentRecord | None:
        with self._lock:
            return self._read().incidents.get(incident_id)

    def drafts(self) -> list[DraftView]:
        """Every accepted draft, oldest incident first, in the architecture.md shape."""
        with self._lock:
            records = list(self._read().incidents.values())
        views: list[DraftView] = []
        for record in records:
            result = record.result
            if record.status != "accepted" or result is None:
                continue
            drafts = result.drafts or ([result.draft] if result.draft is not None else [])
            views.extend(_view(result.incident_id, d, result.fallback) for d in drafts)
        return views

    def _read(self) -> _File:
        if not self._path.exists():
            return _File()
        try:
            return _File.model_validate(json.loads(self._path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, ValidationError) as exc:
            raise StoreCorrupt(f"{self._path.name} is not a valid store file") from exc

    def _write(self, data: _File) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(data.model_dump_json(), encoding="utf-8")
        os.replace(tmp, self._path)
