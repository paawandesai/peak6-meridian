"""Minimal on-chain Solana client for MM loop (M3-02 AC1).

Real implementations using solders/solana-py. Mirrors packages/client (TS) for PDA
derivation and instruction building. Covers only what MM needs: fetch open markets,
mint_pair, place_order, cancel_order, settle_funds.

RPC efficiency (P1-7): Market accounts are fetched with a discriminator memcmp filter;
books and token balances for all markets are read with chunked getMultipleAccounts
(<= 100 keys per call); the recent blockhash is reused within one loop cycle; transaction
confirmation polls getSignatureStatuses on a slot-paced schedule instead of immediately.

SECURITY: MARKET_MAKER_KEYPAIR must never be logged (AC5).
"""

import asyncio
import logging
import struct
import time
from collections.abc import Awaitable, Callable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Commitment, Confirmed, Finalized
from solana.rpc.types import MemcmpOpts
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.system_program import ID as SYSTEM_PROGRAM_ID
from solders.transaction import Transaction
from solders.transaction_status import TransactionConfirmationStatus
from spl.token.instructions import create_associated_token_account

from .types import MarketState, RestingOrder, Side

logger = logging.getLogger(__name__)

# SPL Token program
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

# Instruction discriminators from target/idl/meridian.json
DISCRIMINATOR_PLACE_ORDER = bytes([51, 194, 155, 175, 109, 130, 96, 106])
DISCRIMINATOR_CANCEL_ORDER = bytes([95, 129, 237, 240, 8, 49, 223, 132])
DISCRIMINATOR_MINT_PAIR = bytes([19, 149, 94, 110, 181, 186, 33, 107])
DISCRIMINATOR_SETTLE_FUNDS = bytes([238, 64, 163, 96, 75, 171, 16, 33])

# Account discriminator for Market (target/idl/meridian.json "accounts")
MARKET_DISCRIMINATOR = bytes([219, 190, 213, 55, 0, 227, 198, 154])

# getMultipleAccounts accepts at most 100 pubkeys per request (Solana JSON-RPC limit).
MAX_MULTIPLE_ACCOUNTS = 100

# SPL token account layout: mint (32) | owner (32) | amount u64 LE (8) | ...
SPL_TOKEN_AMOUNT_OFFSET = 64
SPL_TOKEN_AMOUNT_END = SPL_TOKEN_AMOUNT_OFFSET + 8

# A blockhash stays valid for ~150 slots (~60 s); reuse one for at most 20 s of a cycle.
BLOCKHASH_TTL_SECS = 20.0
# Confirmation polling: first check after ~2 slots (~800 ms), then every ~2 slots.
CONFIRM_FIRST_POLL_SECS = 0.8
CONFIRM_POLL_SECS = 0.8
CONFIRM_TIMEOUT_SECS = 90.0

_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


@dataclass(frozen=True)
class Timing:
    """Injectable sleep + monotonic clock (tests drive a simulated clock)."""

    sleep: Callable[[float], Awaitable[None]] = field(default=asyncio.sleep)
    monotonic: Callable[[], float] = field(default=time.monotonic)


class TransactionFailedError(RuntimeError):
    """A sent transaction landed but failed on-chain."""


class ConfirmationTimeoutError(TimeoutError):
    """A sent transaction did not reach the requested commitment in time."""


class _HasData(Protocol):
    @property
    def data(self) -> bytes: ...

    @property
    def owner(self) -> Pubkey: ...


def b58encode(data: bytes) -> str:
    """Base58-encode bytes (Bitcoin alphabet, as used by Solana RPC memcmp filters)."""
    num = int.from_bytes(data, "big")
    out = ""
    while num > 0:
        num, rem = divmod(num, 58)
        out = _B58_ALPHABET[rem] + out
    leading_zeros = len(data) - len(data.lstrip(b"\x00"))
    return "1" * leading_zeros + out


def chunked[T](items: Sequence[T], size: int) -> Iterator[list[T]]:
    """Yield consecutive slices of at most `size` items."""
    if size <= 0:
        raise ValueError(f"chunk size must be positive, got {size}")
    for start in range(0, len(items), size):
        yield list(items[start : start + size])


def parse_token_amount(account: _HasData | None) -> int:
    """Read the u64 amount of an SPL token account; a missing account holds 0.

    Raises ValueError if the account is not a token account (wrong owner or too short).
    """
    if account is None:
        return 0
    if account.owner != TOKEN_PROGRAM_ID:
        raise ValueError(f"not an SPL token account (owner {account.owner})")
    data = bytes(account.data)
    if len(data) < SPL_TOKEN_AMOUNT_END:
        raise ValueError(f"token account too short: {len(data)} bytes")
    amount: int = struct.unpack("<Q", data[SPL_TOKEN_AMOUNT_OFFSET:SPL_TOKEN_AMOUNT_END])[0]
    return amount


def parse_book(data: bytes, market: str) -> list[RestingOrder]:
    """Deserialize a Book account's bids and asks into resting orders.

    Layout: 8-byte Anchor discriminator, then 32 bid slots and 32 ask slots of 64 bytes
    (order_id u64, owner pubkey, price u8, pad [u8; 7], qty u64, seq u64).
    Empty slots (order_id == 0 or qty == 0) are skipped.
    """
    discriminator_size = 8
    order_size = 64
    max_orders_per_side = 32
    sides: tuple[Side, Side] = ("Bid", "Ask")
    orders: list[RestingOrder] = []
    offset = discriminator_size
    for side in sides:
        for _ in range(max_orders_per_side):
            if offset + order_size > len(data):
                return orders
            order_data = data[offset : offset + order_size]
            order_id = struct.unpack("<Q", order_data[0:8])[0]
            qty = struct.unpack("<Q", order_data[48:56])[0]
            if order_id != 0 and qty > 0:
                orders.append(
                    RestingOrder(
                        order_id=order_id,
                        market=market,
                        side=side,
                        price=order_data[40],
                        qty=qty,
                        owner=str(Pubkey(order_data[8:40])),
                    )
                )
            offset += order_size
    return orders


def derive_config_pda(program_id: Pubkey) -> Pubkey:
    """Derive Config PDA: seeds = [b"config"]."""
    seeds = [b"config"]
    pda, _bump = Pubkey.find_program_address(seeds, program_id)
    return pda


def derive_market_pda(
    program_id: Pubkey, ticker: str, trading_date: int, strike_cents: int
) -> Pubkey:
    """Derive Market PDA: seeds = [b"market", ticker_bytes(8), date_le(u32), strike_le(u64)]."""
    # Ticker: 8-byte zero-padded ASCII
    ticker_bytes = ticker.upper().encode("ascii").ljust(8, b"\x00")[:8]
    date_bytes = struct.pack("<I", trading_date)  # u32 little-endian
    strike_bytes = struct.pack("<Q", strike_cents)  # u64 little-endian

    seeds = [b"market", ticker_bytes, date_bytes, strike_bytes]
    pda, _bump = Pubkey.find_program_address(seeds, program_id)
    return pda


def derive_book_pda(program_id: Pubkey, market: Pubkey) -> Pubkey:
    """Derive Book PDA: seeds = [b"book", market_pubkey]."""
    seeds = [b"book", bytes(market)]
    pda, _bump = Pubkey.find_program_address(seeds, program_id)
    return pda


def derive_open_orders_pda(program_id: Pubkey, market: Pubkey, owner: Pubkey) -> Pubkey:
    """Derive OpenOrders PDA: seeds = [b"oo", market_pubkey, owner_pubkey]."""
    seeds = [b"oo", bytes(market), bytes(owner)]
    pda, _bump = Pubkey.find_program_address(seeds, program_id)
    return pda


def derive_escrow_usdc_pda(program_id: Pubkey, market: Pubkey) -> Pubkey:
    """Derive escrow_usdc PDA: seeds = [b"escrow_usdc", market_pubkey]."""
    seeds = [b"escrow_usdc", bytes(market)]
    pda, _bump = Pubkey.find_program_address(seeds, program_id)
    return pda


def derive_escrow_yes_pda(program_id: Pubkey, market: Pubkey) -> Pubkey:
    """Derive escrow_yes PDA: seeds = [b"escrow_yes", market_pubkey]."""
    seeds = [b"escrow_yes", bytes(market)]
    pda, _bump = Pubkey.find_program_address(seeds, program_id)
    return pda


def derive_yes_mint_pda(program_id: Pubkey, market: Pubkey) -> Pubkey:
    """Derive yes_mint PDA: seeds = [b"yes", market_pubkey]."""
    seeds = [b"yes", bytes(market)]
    pda, _bump = Pubkey.find_program_address(seeds, program_id)
    return pda


def derive_no_mint_pda(program_id: Pubkey, market: Pubkey) -> Pubkey:
    """Derive no_mint PDA: seeds = [b"no", market_pubkey]."""
    seeds = [b"no", bytes(market)]
    pda, _bump = Pubkey.find_program_address(seeds, program_id)
    return pda


def derive_vault_pda(program_id: Pubkey, market: Pubkey) -> Pubkey:
    """Derive vault PDA: seeds = [b"vault", market_pubkey]."""
    seeds = [b"vault", bytes(market)]
    pda, _bump = Pubkey.find_program_address(seeds, program_id)
    return pda


def get_associated_token_address(mint: Pubkey, owner: Pubkey) -> Pubkey:
    """Derive associated token account address."""
    # ATA program ID
    ata_program_id = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    seeds = [bytes(owner), bytes(TOKEN_PROGRAM_ID), bytes(mint)]
    pda, _bump = Pubkey.find_program_address(seeds, ata_program_id)
    return pda


class ChainMarketSource:
    """Fetch open markets from on-chain via getProgramAccounts."""

    def __init__(self, rpc_client: AsyncClient, program_id: Pubkey) -> None:
        self.rpc = rpc_client
        self.program_id = program_id

    async def fetch_open_markets(self) -> list[MarketState]:
        """Fetch all open Market accounts and deserialize.

        Market struct layout (from IDL):
        - ticker: [u8; 8] (8 bytes)
        - strike_cents: u64 (8 bytes)
        - trading_date: u32 (4 bytes)
        - close_ts: i64 (8 bytes)
        - yes_mint: Pubkey (32 bytes)
        - no_mint: Pubkey (32 bytes)
        - vault: Pubkey (32 bytes)
        - escrow_usdc: Pubkey (32 bytes)
        - escrow_yes: Pubkey (32 bytes)
        - book: Pubkey (32 bytes)
        - is_open: bool (1 byte)
        - outcome: Option<Outcome> (variable, but we only need is_open)
        - pairs_outstanding: u64 (8 bytes, offset ~233)
        """
        try:
            # P1-7: filter by the Market account discriminator server-side so the RPC
            # returns Market accounts only (not Books / OpenOrders / Config). MemcmpOpts.bytes
            # is a base58 string (solders serializes it with encoding="base58").
            market_discriminator = MARKET_DISCRIMINATOR
            response = await self.rpc.get_program_accounts(
                self.program_id,
                encoding="base64",
                commitment=Confirmed,
                filters=[MemcmpOpts(offset=0, bytes=b58encode(market_discriminator))],
            )

            markets = []
            for account_info in response.value:
                try:
                    # Get the market account pubkey (base58 string)
                    market_pubkey = str(account_info.pubkey)

                    data = account_info.account.data
                    # Skip if too small to be a Market (min size ~250 bytes)
                    min_market_size = 250
                    if len(data) < min_market_size:
                        continue

                    # Check Market discriminator (filter empty Books / other accounts)
                    if data[:8] != market_discriminator:
                        continue

                    # Deserialize Market (simplified: read key fields only)
                    # Anchor adds 8-byte discriminator prefix
                    offset = 8
                    ticker_bytes = data[offset : offset + 8]
                    ticker = ticker_bytes.decode("ascii").rstrip("\x00")
                    offset += 8

                    strike_cents = struct.unpack("<Q", data[offset : offset + 8])[0]
                    offset += 8

                    trading_date = struct.unpack("<I", data[offset : offset + 4])[0]
                    offset += 4

                    close_ts = struct.unpack("<q", data[offset : offset + 8])[0]
                    offset += 8

                    # Skip pubkeys (yes_mint, no_mint, vault, escrow_usdc, escrow_yes, book)
                    offset += 32 * 6  # 6 pubkeys = 192 bytes

                    # pairs_outstanding: u64 (8 bytes) - IDL field 10
                    pairs_outstanding = struct.unpack("<Q", data[offset : offset + 8])[0]
                    offset += 8

                    # status: MarketStatus enum (1 byte) - IDL field 11
                    # 0 = Open, 1 = Settled
                    status = data[offset]
                    offset += 1

                    # Only include Open markets (status == 0)
                    # Note: "Closed" is derived from now >= close_ts, but we include
                    # markets even after close_ts so the pull condition can cancel quotes
                    if status != 0:
                        continue

                    # Use the account pubkey as the market identifier (base58 string)
                    # Keep ticker/date/strike for PDA derivation and display
                    markets.append(
                        MarketState(
                            market=market_pubkey,
                            ticker=ticker,
                            strike_cents=strike_cents,
                            trading_date=trading_date,
                            close_ts=close_ts,
                            is_open=True,  # Filtered to status==0 (Open) above
                            pairs_outstanding=pairs_outstanding,
                        )
                    )
                except Exception:
                    # Skip malformed accounts
                    continue

            return markets
        except Exception:
            logger.exception("Failed to fetch open markets from getProgramAccounts")
            raise


class ChainOrderClient:
    """On-chain order client using solders for transaction building.

    Transactions are still sent and confirmed one at a time (same ordering and failure
    semantics as before P1-7); only the RPC traffic around them is reduced.
    """

    def __init__(
        self,
        rpc_client: AsyncClient,
        program_id: Pubkey,
        payer_keypair: Keypair,
        usdc_mint: Pubkey,
        timing: Timing | None = None,
    ) -> None:
        self.rpc = rpc_client
        self.program_id = program_id
        self.payer = payer_keypair  # MARKET_MAKER_KEYPAIR - NEVER LOGGED
        self.usdc_mint = usdc_mint
        timing = timing or Timing()
        self._sleep = timing.sleep
        self._monotonic = timing.monotonic
        self._blockhash: tuple[Hash, float] | None = None
        # OpenOrders accounts are never closed by the program, so once seen they exist.
        self._known_open_orders: set[Pubkey] = set()

    # --- RPC plumbing ----------------------------------------------------------------------

    def begin_cycle(self) -> None:
        """Start a loop cycle: the next transaction fetches a fresh blockhash.

        Reusing one blockhash within a cycle is safe because no transaction repeats inside
        a cycle; refreshing per cycle keeps identical transactions in consecutive cycles
        (same quote re-placed) from colliding on the same signature.
        """
        self._blockhash = None

    async def _recent_blockhash(self) -> Hash:
        now = self._monotonic()
        if self._blockhash is not None and now - self._blockhash[1] < BLOCKHASH_TTL_SECS:
            return self._blockhash[0]
        resp = await self.rpc.get_latest_blockhash()
        blockhash = resp.value.blockhash
        self._blockhash = (blockhash, now)
        return blockhash

    async def _send_and_confirm(
        self, instructions: list[Instruction], commitment: Commitment = Confirmed
    ) -> Signature:
        """Sign, send and confirm one transaction; raise if it fails or times out."""
        blockhash = await self._recent_blockhash()
        message = Message.new_with_blockhash(instructions, self.payer.pubkey(), blockhash)
        transaction = Transaction([self.payer], message, blockhash)
        sig: Signature = (await self.rpc.send_transaction(transaction)).value
        await self._confirm(sig, commitment)
        return sig

    async def _confirm(self, sig: Signature, commitment: Commitment) -> None:
        """Poll getSignatureStatuses until `sig` reaches `commitment`.

        Unlike AsyncClient.confirm_transaction this waits ~2 slots before the first poll
        (an immediate poll is almost never confirmed) and raises on on-chain errors.
        """
        target = (
            TransactionConfirmationStatus.Finalized
            if commitment == Finalized
            else TransactionConfirmationStatus.Confirmed
        )
        deadline = self._monotonic() + CONFIRM_TIMEOUT_SECS
        await self._sleep(CONFIRM_FIRST_POLL_SECS)
        while True:
            status = (await self.rpc.get_signature_statuses([sig])).value[0]
            if status is not None:
                if status.err is not None:
                    raise TransactionFailedError(f"transaction {sig} failed: {status.err}")
                level = status.confirmation_status
                if level is not None and int(level) >= int(target):
                    return
            if self._monotonic() >= deadline:
                raise ConfirmationTimeoutError(
                    f"transaction {sig} not {commitment} after {CONFIRM_TIMEOUT_SECS:.0f}s"
                )
            await self._sleep(CONFIRM_POLL_SECS)

    async def _get_multiple_accounts(self, keys: Sequence[Pubkey]) -> list[_HasData | None]:
        """Read accounts with getMultipleAccounts, at most 100 keys per request.

        RPC errors propagate: callers must fail closed rather than act on missing data.
        """
        accounts: list[_HasData | None] = []
        for chunk in chunked(keys, MAX_MULTIPLE_ACCOUNTS):
            resp = await self.rpc.get_multiple_accounts(chunk, commitment=Confirmed)
            values = list(resp.value)
            if len(values) != len(chunk):
                raise RuntimeError(
                    f"getMultipleAccounts returned {len(values)} accounts for {len(chunk)} keys"
                )
            accounts.extend(values)
        return accounts

    # --- reads -----------------------------------------------------------------------------

    async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
        """Fetch resting orders for one market from its Book account.

        Raises on RPC errors (AB-10: never place orders without seeing existing ones).

        Args:
            market: Market PDA (base58 pubkey string)
        """
        try:
            book_pda = derive_book_pda(self.program_id, Pubkey.from_string(market))
            resp = await self.rpc.get_account_info(book_pda)
            if not resp.value or not resp.value.data:
                return []
            return parse_book(bytes(resp.value.data), market)
        except Exception:
            logger.exception(f"Failed to fetch resting orders for {market}")
            raise

    async def fetch_resting_orders_batch(self, markets: list[str]) -> dict[str, list[RestingOrder]]:
        """Fetch resting orders for many markets with chunked getMultipleAccounts (P1-7).

        Returns an entry for every market (a missing Book reads as an empty book).
        Raises on RPC errors so the loop fails closed (AB-10).
        """
        book_pdas = [derive_book_pda(self.program_id, Pubkey.from_string(m)) for m in markets]
        accounts = await self._get_multiple_accounts(book_pdas)
        return {
            market: parse_book(bytes(account.data), market) if account else []
            for market, account in zip(markets, accounts, strict=True)
        }

    async def get_yes_token_balance(self, market: str, owner: str) -> int:
        """Get YES token balance for owner in market (0 if the ATA doesn't exist).

        Propagates RPC errors (timeouts, 429, connection errors) to caller.
        """
        yes_mint = derive_yes_mint_pda(self.program_id, Pubkey.from_string(market))
        user_yes = get_associated_token_address(yes_mint, Pubkey.from_string(owner))
        return parse_token_amount((await self.rpc.get_account_info(user_yes)).value)

    async def get_no_token_balance(self, market: str, owner: str) -> int:
        """Get NO token balance for owner in market (0 if the ATA doesn't exist).

        Propagates RPC errors (timeouts, 429, connection errors) to caller.
        """
        no_mint = derive_no_mint_pda(self.program_id, Pubkey.from_string(market))
        user_no = get_associated_token_address(no_mint, Pubkey.from_string(owner))
        return parse_token_amount((await self.rpc.get_account_info(user_no)).value)

    async def get_multiple_token_balances(
        self, markets: list[str], owner: str
    ) -> dict[str, tuple[int, int]]:
        """Batch-read (YES, NO) balances for many markets (P1-7).

        One getMultipleAccounts call per 50 markets (2 ATAs each, <= 100 keys per call).
        A missing ATA reads as 0. RPC errors propagate (fail loudly; the loop must not
        quote on unknown inventory). A market whose ATA is not a valid token account is
        logged and omitted, so only that market is skipped.
        """
        owner_pubkey = Pubkey.from_string(owner)
        keys: list[Pubkey] = []
        for market in markets:
            market_pda = Pubkey.from_string(market)
            for mint in (
                derive_yes_mint_pda(self.program_id, market_pda),
                derive_no_mint_pda(self.program_id, market_pda),
            ):
                keys.append(get_associated_token_address(mint, owner_pubkey))
        accounts = await self._get_multiple_accounts(keys)

        balances: dict[str, tuple[int, int]] = {}
        for i, market in enumerate(markets):
            try:
                yes = parse_token_amount(accounts[2 * i])
                no = parse_token_amount(accounts[2 * i + 1])
            except ValueError:
                logger.exception(f"Invalid token account for {market}; skipping market")
                continue
            balances[market] = (yes, no)
        return balances

    # --- transactions ----------------------------------------------------------------------

    async def place_order(  # noqa: PLR0913, PLR0917 - OrderClient signature + optional snapshot
        self,
        market: str,
        side: str,
        price: int,
        qty: int,
        owner: str,
        resting_orders: list[RestingOrder] | None = None,
    ) -> int:
        """Place order via place_order instruction.

        Instruction args (Borsh):
        - side: enum { Bid = 0, Ask = 1 }
        - price: u8
        - qty: u64
        - kind: enum { Limit = 0, Ioc = 1 }

        Args:
            market: Market PDA (base58 pubkey string)
            resting_orders: The market's resting orders if the caller just read them
                (P1-7: saves a Book read per order). Fetched when None.
        """
        market_pda = Pubkey.from_string(market)
        owner_pubkey = Pubkey.from_string(owner)

        # Build instruction data
        side_byte = 0 if side == "Bid" else 1
        kind_byte = 0  # Limit order
        data = (
            DISCRIMINATOR_PLACE_ORDER
            + struct.pack("<B", side_byte)  # side enum
            + struct.pack("<B", price)  # price u8
            + struct.pack("<Q", qty)  # qty u64
            + struct.pack("<B", kind_byte)  # kind enum
        )

        # Account metas (matching IDL order)
        config = derive_config_pda(self.program_id)
        book = derive_book_pda(self.program_id, market_pda)
        open_orders = derive_open_orders_pda(self.program_id, market_pda, owner_pubkey)
        user_usdc = get_associated_token_address(self.usdc_mint, owner_pubkey)
        yes_mint = derive_yes_mint_pda(self.program_id, market_pda)
        user_yes = get_associated_token_address(yes_mint, owner_pubkey)
        escrow_usdc = derive_escrow_usdc_pda(self.program_id, market_pda)
        escrow_yes = derive_escrow_yes_pda(self.program_id, market_pda)

        accounts = [
            AccountMeta(pubkey=config, is_signer=False, is_writable=False),
            AccountMeta(pubkey=market_pda, is_signer=False, is_writable=False),
            AccountMeta(pubkey=book, is_signer=False, is_writable=True),
            AccountMeta(pubkey=owner_pubkey, is_signer=True, is_writable=True),
            AccountMeta(pubkey=open_orders, is_signer=False, is_writable=True),
            AccountMeta(pubkey=user_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=user_yes, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow_yes, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(pubkey=SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        # Include every resting owner's OpenOrders in remaining_accounts. Program needs them:
        # - contra-side owners (credit_other when taker crosses)
        # - same-side owners (refund when displaced from full book)
        # The signer's open_orders is already in the named accounts, so exclude it.
        if resting_orders is None:
            resting_orders = await self.fetch_resting_orders(market)

        all_owners = {Pubkey.from_string(o.owner) for o in resting_orders}
        all_owners.discard(owner_pubkey)  # Signer already in named accounts

        remaining_accounts = [
            AccountMeta(
                pubkey=derive_open_orders_pda(self.program_id, market_pda, other),
                is_signer=False,
                is_writable=True,
            )
            for other in sorted(all_owners, key=bytes)
        ]

        instruction = Instruction(self.program_id, data, accounts + remaining_accounts)
        await self._send_and_confirm([instruction])
        # Return a mock order ID (in production, parse from events/logs)
        return 1

    async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
        """Cancel order via cancel_order instruction.

        Instruction args (Borsh):
        - order_id: u64 (per IDL)

        Args:
            market: Market PDA (base58 pubkey string)
        """
        market_pda = Pubkey.from_string(market)
        owner_pubkey = Pubkey.from_string(owner)

        # Build instruction data
        data = DISCRIMINATOR_CANCEL_ORDER + struct.pack("<Q", order_id)  # u64

        # Account metas
        book = derive_book_pda(self.program_id, market_pda)
        open_orders = derive_open_orders_pda(self.program_id, market_pda, owner_pubkey)

        accounts = [
            AccountMeta(pubkey=market_pda, is_signer=False, is_writable=False),
            AccountMeta(pubkey=book, is_signer=False, is_writable=True),
            AccountMeta(pubkey=owner_pubkey, is_signer=True, is_writable=False),
            AccountMeta(pubkey=open_orders, is_signer=False, is_writable=True),
        ]

        await self._send_and_confirm([Instruction(self.program_id, data, accounts)])

    async def _ensure_ata(self, ata: Pubkey, mint: Pubkey, owner: Pubkey) -> None:
        """Create an associated token account if it doesn't exist (idempotent)."""
        # Missing accounts return value=None, not an exception
        if (await self.rpc.get_account_info(ata)).value is not None:
            return
        # Use Finalized so the account is fully indexed before mint_pair
        create_ix = create_associated_token_account(self.payer.pubkey(), owner, mint)
        await self._send_and_confirm([create_ix], commitment=Finalized)
        if (await self.rpc.get_account_info(ata)).value is None:
            logger.warning(f"ATA creation finalized but refetch returned None: {ata}")

    async def mint_pair(self, market: str, qty: int, owner: str) -> None:
        """Mint YES+NO pair via mint_pair instruction.

        Instruction args (Borsh):
        - qty: u64

        Args:
            market: Market PDA (base58 pubkey string)
        """
        market_pda = Pubkey.from_string(market)
        owner_pubkey = Pubkey.from_string(owner)

        # Build instruction data
        data = DISCRIMINATOR_MINT_PAIR + struct.pack("<Q", qty)  # qty u64

        # Account metas
        config = derive_config_pda(self.program_id)
        user_usdc = get_associated_token_address(self.usdc_mint, owner_pubkey)
        yes_mint = derive_yes_mint_pda(self.program_id, market_pda)
        no_mint = derive_no_mint_pda(self.program_id, market_pda)
        user_yes = get_associated_token_address(yes_mint, owner_pubkey)
        user_no = get_associated_token_address(no_mint, owner_pubkey)
        vault = derive_vault_pda(self.program_id, market_pda)

        # Create YES/NO ATAs idempotently (required for mint_pair)
        await self._ensure_ata(user_yes, yes_mint, owner_pubkey)
        await self._ensure_ata(user_no, no_mint, owner_pubkey)

        # IDL: user is signer but not writable
        accounts = [
            AccountMeta(pubkey=config, is_signer=False, is_writable=False),
            AccountMeta(pubkey=market_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=owner_pubkey, is_signer=True, is_writable=False),
            AccountMeta(pubkey=user_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=user_yes, is_signer=False, is_writable=True),
            AccountMeta(pubkey=user_no, is_signer=False, is_writable=True),
            AccountMeta(pubkey=yes_mint, is_signer=False, is_writable=True),
            AccountMeta(pubkey=no_mint, is_signer=False, is_writable=True),
            AccountMeta(pubkey=vault, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        await self._send_and_confirm([Instruction(self.program_id, data, accounts)])

    async def settle_funds(self, market: str, owner: str) -> None:
        """Settle funds via settle_funds instruction (no args).

        Skips if OpenOrders account doesn't exist (nothing to settle on first run). The
        existence check runs once per OpenOrders account: the program never closes them.

        Args:
            market: Market PDA (base58 pubkey string)
        """
        market_pda = Pubkey.from_string(market)
        owner_pubkey = Pubkey.from_string(owner)

        # Check if OpenOrders exists (created by first place_order; nothing to settle if not)
        open_orders = derive_open_orders_pda(self.program_id, market_pda, owner_pubkey)
        if open_orders not in self._known_open_orders:
            if (await self.rpc.get_account_info(open_orders)).value is None:
                return  # OpenOrders doesn't exist yet - nothing to settle
            self._known_open_orders.add(open_orders)

        # Account metas
        escrow_usdc = derive_escrow_usdc_pda(self.program_id, market_pda)
        escrow_yes = derive_escrow_yes_pda(self.program_id, market_pda)
        user_usdc = get_associated_token_address(self.usdc_mint, owner_pubkey)
        yes_mint = derive_yes_mint_pda(self.program_id, market_pda)
        user_yes = get_associated_token_address(yes_mint, owner_pubkey)

        accounts = [
            AccountMeta(pubkey=market_pda, is_signer=False, is_writable=False),
            AccountMeta(pubkey=owner_pubkey, is_signer=True, is_writable=False),
            AccountMeta(pubkey=open_orders, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow_yes, is_signer=False, is_writable=True),
            AccountMeta(pubkey=user_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=user_yes, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        # Instruction data: discriminator only (no args)
        instruction = Instruction(self.program_id, DISCRIMINATOR_SETTLE_FUNDS, accounts)
        await self._send_and_confirm([instruction])
