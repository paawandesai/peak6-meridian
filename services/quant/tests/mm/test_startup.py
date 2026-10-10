"""MM startup: wait for the first fair values before the first tick; log to stdout.

Railway 2026-10-10: the MM's first tick ran before the fair-value refresher had priced anything
and logged "Pulling all quotes: no fair values available" on every boot; every stderr line was
tagged as an error.
"""

import logging
import subprocess
import sys

import pytest

from meridian_quant.mm.main import wait_for_first_fair_values


class _FakeTime:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    async def sleep(self, secs: float) -> None:
        self.sleeps.append(secs)
        self.now += secs


@pytest.fixture
def fake_time() -> _FakeTime:
    return _FakeTime()


@pytest.mark.asyncio
async def test_returns_immediately_when_values_are_ready(fake_time: _FakeTime) -> None:
    ready = await wait_for_first_fair_values(
        lambda: [object(), object()], clock=fake_time.clock, sleep=fake_time.sleep
    )
    assert ready == 2
    assert fake_time.sleeps == []


@pytest.mark.asyncio
async def test_waits_until_the_first_refresh_lands(
    fake_time: _FakeTime, caplog: pytest.LogCaptureFixture
) -> None:
    snapshots: list[list[object]] = [[], [], [object()]]

    def snapshot() -> list[object]:
        return snapshots.pop(0) if len(snapshots) > 1 else snapshots[0]

    with caplog.at_level(logging.INFO, logger="meridian_quant.mm.main"):
        ready = await wait_for_first_fair_values(
            snapshot, poll_secs=0.5, clock=fake_time.clock, sleep=fake_time.sleep
        )
    assert ready == 1
    assert fake_time.sleeps == [0.5, 0.5]
    assert "First fair values ready: 1 markets" in caplog.text


@pytest.mark.asyncio
async def test_gives_up_after_the_timeout_and_says_so(
    fake_time: _FakeTime, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="meridian_quant.mm.main"):
        ready = await wait_for_first_fair_values(
            lambda: [],
            timeout_secs=3.0,
            poll_secs=1.0,
            clock=fake_time.clock,
            sleep=fake_time.sleep,
        )
    assert ready == 0
    assert fake_time.now == pytest.approx(3.0)
    assert "No fair values after 3s; starting the MM anyway" in caplog.text


def test_logs_go_to_stdout() -> None:
    # A fresh interpreter: pytest has already configured logging in this one.
    code = (
        "import logging, meridian_quant.mm.main; "
        "logging.getLogger('meridian_quant.mm.main').warning('startup-probe')"
    )
    done = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=60, check=True
    )
    assert "startup-probe" in done.stdout
    assert "startup-probe" not in done.stderr
