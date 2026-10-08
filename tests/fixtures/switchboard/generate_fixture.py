"""Regenerates pull_feed_meta_tiingo.json: a Switchboard On-Demand `PullFeedAccountData` account
laid out as in the `switchboard-on-demand` 0.13.x `#[repr(C)]` struct (3,208 bytes with the
8-byte discriminator). Pure standard library, no network: `python3 -I generate_fixture.py`.

Replace the output with a real `solana account <feed> --output json -u devnet` capture once the
live spike (OQ-11) can reach devnet; the program tests read it unchanged.
"""

import base64
import json
import struct
import sys
from pathlib import Path

DEVNET_PID = "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2"
DISCRIMINATOR = bytes([196, 27, 108, 196, 10, 215, 219, 40])
CLOSE_TS = 1_791_316_800  # 2026-10-06 16:00 ET
SLOT = 412_345_678
VALUE = 681_250_000_000_000_000_000  # $681.25 with 18 fractional digits
FEED_HASH = bytes([0xAB] * 32)


def i128(value: int) -> bytes:
    return value.to_bytes(16, "little", signed=True)


def build() -> bytes:
    out = bytearray(DISCRIMINATOR)
    for index in range(32):  # submissions: oracle, slot, landed_at, value
        if index < 3:
            out += bytes([index + 1] * 32) + struct.pack("<QQ", SLOT - index, SLOT - index + 1)
            out += i128(VALUE + (index - 1) * 10**15)
        else:
            out += bytes(64)
    out += bytes([0x11] * 32)  # authority
    out += bytes([0x22] * 32)  # queue
    out += FEED_HASH
    # initialized_at, permissions, max_variance, min_responses
    out += struct.pack("<qQQI", 1_700_000_000, 0, 0, 1)
    out += b"META close tiingo".ljust(32, b"\0")  # name
    # padding1, permit_write_by_authority, historical_result_idx, min_sample_size
    out += bytes([0, 0, 0, 1])
    out += struct.pack("<qQ", CLOSE_TS + 301, 0)  # last_update_timestamp, lut_slot
    out += bytes(32)  # _reserved1
    # CurrentResult: value, std_dev, mean, range, min_value, max_value, then counters and slots.
    out += i128(VALUE) + i128(10**15) + i128(VALUE) + i128(2 * 10**15)
    out += i128(VALUE - 10**15) + i128(VALUE + 10**15)
    out += bytes([3, 0]) + bytes(6) + struct.pack("<QQQ", SLOT, SLOT - 2, SLOT)
    out += struct.pack("<I", 0) + bytes(12)  # max_staleness, padding2
    out += bytes(32 * 16)  # historical_results
    out += bytes(8 + 24)  # _ebuf4, _ebuf3
    out += struct.pack("<32q", *([CLOSE_TS + 300] * 3 + [0] * 29))  # submission_timestamps
    assert len(out) == 3208, len(out)
    return bytes(out)


def main() -> None:
    target = Path(__file__).with_name("pull_feed_meta_tiingo.json")
    account = {
        "pubkey": "11111111111111111111111111111111",
        "account": {
            "lamports": 24_000_000,
            "data": [base64.b64encode(build()).decode(), "base64"],
            "owner": DEVNET_PID,
            "executable": False,
            "rentEpoch": 18446744073709551615,
            "space": 3208,
        },
    }
    target.write_text(json.dumps(account, indent=2) + "\n")
    sys.stdout.write(f"wrote {target}\n")


main()
