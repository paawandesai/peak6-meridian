"""Scanners for text that must never appear in an override draft (AB-14, AB-15, AB-20).

Every function returns a *description* of what matched, never the matched text, so callers can
log results without echoing a leaked credential.
"""

from __future__ import annotations

import re

__all__ = [
    "DELIMITER_CLOSE",
    "DELIMITER_OPEN",
    "contains_delimiter",
    "contains_url",
    "looks_like_key",
    "neutralize_delimiters",
]

# Delimiters of the untrusted-data block in prompts (see prompt.py). External text is never
# allowed to contain them, so it can neither close a block nor open a fake one.
DELIMITER_OPEN = "<<<"
DELIMITER_CLOSE = ">>>"

_KEY_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{8,}"), "anthropic-style api key"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), "sk- style api key"),
    (re.compile(r"\bglpat-[A-Za-z0-9_-]{16,}"), "gitlab token"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"), "github token"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "slack token"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "aws access key"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "pem private key"),
    (re.compile(r"\b[0-9a-fA-F]{64,}\b"), "hex secret (64+ hex chars)"),
    # Solana secret keys as exported by solana-keygen: a JSON array of 64 bytes.
    (re.compile(r"\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]"), "byte-array secret key"),
    # Base58 secret keys are 87-88 chars; public keys (32-44 chars) stay allowed.
    (re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{80,}\b"), "base58 secret key"),
    (
        re.compile(
            r"(?i)\b(?:api[_ -]?key|secret(?:[_ -]?key)?|token|password|keypair)\b"
            r"\s*(?:[:=]|is)\s*[\"'`]?[A-Za-z0-9_\-./+=\[\],]{8,}"
        ),
        "credential assignment",
    ),
)

_URL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\b(?:https?|ftp|wss?|ssh|file|ipfs)://"),
    re.compile(r"(?i)\bwww\.[a-z0-9-]+\.[a-z]{2,}"),
    re.compile(
        r"(?i)\b[a-z0-9-]+(?:\.[a-z0-9-]+)*"
        r"\.(?:com|net|org|io|dev|app|xyz|co|gg|ai|sh|invalid|example|test|onion|localhost)"
        r"\b(?:/\S*)?"
    ),
)


def looks_like_key(text: str) -> str | None:
    """Return a description of the first key-like token in ``text``, or ``None``."""
    for pattern, description in _KEY_PATTERNS:
        if pattern.search(text):
            return description
    return None


def contains_url(text: str) -> bool:
    """True when ``text`` contains anything that looks like a URL or hostname."""
    return any(pattern.search(text) for pattern in _URL_PATTERNS)


def contains_delimiter(text: str) -> bool:
    """True when ``text`` contains the untrusted-data block delimiters."""
    return DELIMITER_OPEN in text or DELIMITER_CLOSE in text


def neutralize_delimiters(text: str) -> str:
    """Break any delimiter sequence in external text so it cannot escape its block."""
    return text.replace(DELIMITER_OPEN, "< < <").replace(DELIMITER_CLOSE, "> > >")
