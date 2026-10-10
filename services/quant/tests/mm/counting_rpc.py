"""Counting fake Solana RPC for measuring MM RPC usage (P1-7).

`CountingRpc` stands in for `solana.rpc.async_api.AsyncClient`. It serves a static devnet-like
world (Market, Book, OpenOrders and YES/NO token accounts for every market), counts every RPC
method call, and keeps a simulated clock: each call costs `latency_secs`, sleeps advance the
clock, and a sent transaction reaches `confirmed` `confirm_after_secs` after it was sent.

Sent transactions do not mutate the world, so every loop iteration sees the same steady state:
each market holds one MM bid and one MM ask, the MM wallet holds enough YES to quote (no mints),
and the MM OpenOrders account exists. That is the 5-second steady state the MM spends its day in.

The harness only uses API surface that existed before P1-7 as well (per-account reads,
`confirm_transaction`), so the same world can be replayed against the pre-P1-7 loop.
"""

from __future__ import annotations

import struct
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import Transaction
from solders.transaction_status import TransactionConfirmationStatus

from meridian_quant.mm.chain import (
    TOKEN_PROGRAM_ID,
    derive_book_pda,
    derive_market_pda,
    derive_no_mint_pda,
    derive_open_orders_pda,
    derive_yes_mint_pda,
    get_associated_token_address,
)
from meridian_quant.mm.types import FairValue, MarketState

MARKET_DISCRIMINATOR = bytes([219, 190, 213, 55, 0, 227, 198, 154])
BOOK_DISCRIMINATOR = bytes([1, 2, 3, 4, 5, 6, 7, 8])
OPEN_ORDERS_DISCRIMINATOR = bytes([9, 9, 9, 9, 9, 9, 9, 9])
ORDER_SIZE = 64
SLOTS_PER_SIDE = 32

# Realistic devnet day: 7 tickers x 11 strikes (domain.md: MAG7, strikes around spot).
TICKERS = ("AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA")
STRIKES_PER_TICKER = 11

# Fixed "now" for the loop clock: 2026-10-08 14:00 ET, market closes 2 h later.
SIM_NOW = datetime(2026, 10, 8, 18, 0, 0, tzinfo=UTC)
SIM_TRADING_DATE = 20261008

_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode(text: str) -> bytes:
    """Reference base58 decoder (test-only) used to apply memcmp filters."""
    num = 0
    for char in text:
        num = num * 58 + _B58_ALPHABET.index(char)
    body = num.to_bytes((num.bit_length() + 7) // 8, "big") if num else b""
    leading_zeros = len(text) - len(text.lstrip("1"))
    return b"\x00" * leading_zeros + body


@dataclass(frozen=True)
class FakeAccount:
    """Minimal account shape the MM reads: `.data` and `.owner`."""

    data: bytes
    owner: Pubkey


@dataclass(frozen=True)
class FakeKeyedAccount:
    """getProgramAccounts element: `.pubkey` and `.account`."""

    pubkey: Pubkey
    account: FakeAccount


@dataclass(frozen=True)
class FakeResp:
    """Generic `{"value": ...}` RPC response."""

    value: Any


@dataclass(frozen=True)
class FakeBlockhash:
    blockhash: Hash


@dataclass(frozen=True)
class FakeTokenAmount:
    amount: str


@dataclass(frozen=True)
class FakeStatus:
    confirmation_status: TransactionConfirmationStatus | None
    err: object | None


def _market_data(ticker: str, strike_cents: int, close_ts: int) -> bytes:
    data = (
        MARKET_DISCRIMINATOR
        + ticker.encode("ascii").ljust(8, b"\x00")
        + struct.pack("<Q", strike_cents)
        + struct.pack("<I", SIM_TRADING_DATE)
        + struct.pack("<q", close_ts)
        + b"\x00" * (32 * 6)
        + struct.pack("<Q", 1_000)  # pairs_outstanding
        + b"\x00"  # status = Open
    )
    return data.ljust(260, b"\x00")


def _order_bytes(order_id: int, owner: Pubkey, price: int, qty: int) -> bytes:
    return (
        struct.pack("<Q", order_id)
        + bytes(owner)
        + bytes([price])
        + b"\x00" * 7
        + struct.pack("<Q", qty)
        + struct.pack("<Q", order_id)  # seq
    )


def book_data(bids: Sequence[bytes], asks: Sequence[bytes]) -> bytes:
    """Serialize a Book: discriminator, 32 bid slots, 32 ask slots (64 bytes each)."""
    empty = b"\x00" * ORDER_SIZE
    bid_slots = list(bids) + [empty] * (SLOTS_PER_SIDE - len(bids))
    ask_slots = list(asks) + [empty] * (SLOTS_PER_SIDE - len(asks))
    return BOOK_DISCRIMINATOR + b"".join(bid_slots) + b"".join(ask_slots)


def token_account_data(mint: Pubkey, owner: Pubkey, amount: int) -> bytes:
    """Serialize an SPL token account (165 bytes; amount u64 at offset 64)."""
    return (bytes(mint) + bytes(owner) + struct.pack("<Q", amount)).ljust(165, b"\x00")


@dataclass
class CountingRpc:
    """Counting, clock-simulating stand-in for AsyncClient (see module docstring)."""

    program_id: Pubkey
    owner: Pubkey
    latency_secs: float = 0.1
    confirm_after_secs: float = 0.8
    now: float = 0.0
    calls: Counter[str] = field(default_factory=Counter)
    accounts: dict[Pubkey, FakeAccount] = field(default_factory=dict)
    markets: list[MarketState] = field(default_factory=list)
    sent_at: dict[Signature, float] = field(default_factory=dict)
    gma_batch_sizes: list[int] = field(default_factory=list)
    gpa_filters: list[object] = field(default_factory=list)

    @property
    def total_calls(self) -> int:
        return sum(self.calls.values())

    def reset_counts(self) -> None:
        self.calls.clear()
        self.gma_batch_sizes.clear()

    def _tick(self, method: str) -> None:
        self.calls[method] += 1
        self.now += self.latency_secs

    async def sleep(self, secs: float) -> None:
        """Simulated sleep: advance the clock without an RPC call."""
        self.now += secs

    def monotonic(self) -> float:
        return self.now

    # --- world setup -------------------------------------------------------------------------

    def seed_market(self, ticker: str, strike_cents: int, yes: int, no: int) -> MarketState:
        """Add one open market with one MM bid + one MM ask resting and MM balances."""
        close_ts = int((SIM_NOW + timedelta(hours=2)).timestamp())
        market = derive_market_pda(self.program_id, ticker, SIM_TRADING_DATE, strike_cents)
        self.accounts[market] = FakeAccount(
            _market_data(ticker, strike_cents, close_ts), self.program_id
        )
        order_id = 2 * len(self.markets) + 1
        self.accounts[derive_book_pda(self.program_id, market)] = FakeAccount(
            book_data(
                bids=[_order_bytes(order_id, self.owner, 48, 10)],
                asks=[_order_bytes(order_id + 1, self.owner, 52, 10)],
            ),
            self.program_id,
        )
        oo = derive_open_orders_pda(self.program_id, market, self.owner)
        self.accounts[oo] = FakeAccount(OPEN_ORDERS_DISCRIMINATOR + b"\x00" * 120, self.program_id)
        for mint_pda, amount in (
            (derive_yes_mint_pda(self.program_id, market), yes),
            (derive_no_mint_pda(self.program_id, market), no),
        ):
            ata = get_associated_token_address(mint_pda, self.owner)
            self.accounts[ata] = FakeAccount(
                token_account_data(mint_pda, self.owner, amount), TOKEN_PROGRAM_ID
            )
        state = MarketState(
            market=str(market),
            ticker=ticker,
            strike_cents=strike_cents,
            trading_date=SIM_TRADING_DATE,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=1_000,
        )
        self.markets.append(state)
        return state

    def fair_values(self) -> list[FairValue]:
        return [
            FairValue(
                market=m.market,
                ticker=m.ticker,
                strike_cents=m.strike_cents,
                fair_cents=50,
                sigma=0.3,
                spot=230.0,
                as_of=SIM_NOW,
            )
            for m in self.markets
        ]

    # --- AsyncClient surface -----------------------------------------------------------------

    async def get_program_accounts(
        self,
        pubkey: Pubkey,
        *_args: object,
        filters: Sequence[object] | None = None,
        **_kwargs: object,
    ) -> FakeResp:
        self._tick("getProgramAccounts")
        self.gpa_filters.append(list(filters or []))
        result = []
        for key, account in self.accounts.items():
            if account.owner != pubkey:
                continue
            if all(self._filter_matches(f, account.data) for f in (filters or [])):
                result.append(FakeKeyedAccount(key, account))
        return FakeResp(result)

    @staticmethod
    def _filter_matches(flt: object, data: bytes) -> bool:
        offset = getattr(flt, "offset", None)
        raw = getattr(flt, "bytes", None)
        if not isinstance(offset, int) or not isinstance(raw, str):
            raise TypeError(f"unsupported filter {flt!r}")
        needle = b58decode(raw)  # RPC semantics: MemcmpOpts.bytes is base58
        return data[offset : offset + len(needle)] == needle

    async def get_account_info(self, pubkey: Pubkey, *_a: object, **_k: object) -> FakeResp:
        self._tick("getAccountInfo")
        return FakeResp(self.accounts.get(pubkey))

    async def get_multiple_accounts(
        self, pubkeys: Sequence[Pubkey], *_a: object, **_k: object
    ) -> FakeResp:
        self._tick("getMultipleAccounts")
        if len(pubkeys) > 100:
            raise ValueError("getMultipleAccounts: too many keys (max 100)")
        self.gma_batch_sizes.append(len(pubkeys))
        return FakeResp([self.accounts.get(k) for k in pubkeys])

    async def get_token_account_balance(
        self, pubkey: Pubkey, *_a: object, **_k: object
    ) -> FakeResp:
        self._tick("getTokenAccountBalance")
        account = self.accounts[pubkey]
        (amount,) = struct.unpack("<Q", account.data[64:72])
        return FakeResp(FakeTokenAmount(str(amount)))

    async def get_latest_blockhash(self, *_a: object, **_k: object) -> FakeResp:
        self._tick("getLatestBlockhash")
        return FakeResp(FakeBlockhash(Hash.new_unique()))

    async def send_transaction(self, txn: Transaction, *_a: object, **_k: object) -> FakeResp:
        self._tick("sendTransaction")
        sig = txn.signatures[0]
        if sig in self.sent_at:
            raise RuntimeError("Transaction already processed (duplicate signature)")
        self.sent_at[sig] = self.now
        return FakeResp(sig)

    def _status(self, sig: Signature) -> FakeStatus | None:
        sent = self.sent_at.get(sig)
        if sent is None or self.now - sent < self.confirm_after_secs:
            return None
        return FakeStatus(TransactionConfirmationStatus.Finalized, None)

    async def get_signature_statuses(
        self, signatures: Sequence[Signature], *_a: object, **_k: object
    ) -> FakeResp:
        self._tick("getSignatureStatuses")
        if len(signatures) > 256:
            raise ValueError("getSignatureStatuses: too many signatures (max 256)")
        return FakeResp([self._status(s) for s in signatures])

    async def confirm_transaction(
        self, tx_sig: Signature, *_a: object, sleep_seconds: float = 0.5, **_k: object
    ) -> FakeResp:
        """Mirror solana-py's AsyncClient.confirm_transaction polling loop.

        solana-py polls getSignatureStatuses immediately after sending, then every
        `sleep_seconds` until the status reaches the requested commitment.
        """
        while True:
            resp = await self.get_signature_statuses([tx_sig])
            if resp.value[0] is not None:
                return resp
            await self.sleep(sleep_seconds)

    async def close(self) -> None:
        return None


def seed_world(rpc: CountingRpc, tickers: Sequence[str], strikes: int) -> None:
    """Seed `len(tickers) * strikes` open markets with steady-state MM inventory."""
    for ticker in tickers:
        for i in range(strikes):
            rpc.seed_market(ticker, 20_000 + i * 500, yes=100, no=90)


def new_owner() -> Keypair:
    return Keypair()
