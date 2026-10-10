"""Rate-limited warnings for loops that run every second or two (M3-08b).

A condition that persists (a provider down, quotes pulled) is logged at WARNING when it first
appears and then at most once per `interval_secs` per key; repeats in between go to DEBUG, so
the condition stays visible without flooding the log. Clock injectable for tests.
"""

import logging
import threading
import time
from collections.abc import Callable

DEFAULT_INTERVAL_SECS = 60.0


class RateLimitedLog:
    def __init__(
        self,
        logger: logging.Logger,
        interval_secs: float = DEFAULT_INTERVAL_SECS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._logger = logger
        self._interval = interval_secs
        self._clock = clock
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()

    def log(self, key: str, message: str, level: int = logging.WARNING) -> bool:
        """Logs `message` at `level` if `key` was not logged loudly within the interval, else
        at DEBUG. Returns True when it logged at `level`."""
        now = self._clock()
        with self._lock:
            last = self._last.get(key)
            loud = last is None or now - last >= self._interval
            if loud:
                self._last[key] = now
        self._logger.log(level if loud else logging.DEBUG, message)
        return loud

    def warning(self, key: str, message: str) -> bool:
        return self.log(key, message, logging.WARNING)

    def clear(self, key: str) -> None:
        """Forget `key`, so the next occurrence of its condition is logged at WARNING again."""
        with self._lock:
            self._last.pop(key, None)

    def active(self, key: str) -> bool:
        with self._lock:
            return key in self._last
