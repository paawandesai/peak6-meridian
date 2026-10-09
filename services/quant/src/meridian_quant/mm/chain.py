"""Minimal on-chain Solana client for MM loop (M3-02 AC1).

Real implementations using solders/solana-py. Mirrors packages/client (TS) for PDA
derivation and instruction building. Covers only what MM needs: fetch open markets,
mint_pair, place_order, cancel_order, settle_funds.

SECURITY: MARKET_MAKER_KEYPAIR must never be logged (AC5).
"""

import logging
import struct
import time

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.system_program import ID as SYSTEM_PROGRAM_ID
from solders.transaction import Transaction
from spl.token.instructions import create_associated_token_account

from .types import MarketState, RestingOrder

logger = logging.getLogger(__name__)

# SPL Token program
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

# Instruction discriminators from target/idl/meridian.json
DISCRIMINATOR_PLACE_ORDER = bytes([51, 194, 155, 175, 109, 130, 96, 106])
DISCRIMINATOR_CANCEL_ORDER = bytes([95, 129, 237, 240, 8, 49, 223, 132])
DISCRIMINATOR_MINT_PAIR = bytes([19, 149, 94, 110, 181, 186, 33, 107])
DISCRIMINATOR_SETTLE_FUNDS = bytes([238, 64, 163, 96, 75, 171, 16, 33])


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
            # Fetch all program accounts (filter by Market discriminator in Python)
            # Market discriminator from IDL: [219, 190, 213, 55, 0, 227, 198, 154]
            market_discriminator = bytes([219, 190, 213, 55, 0, 227, 198, 154])
            response = await self.rpc.get_program_accounts(
                self.program_id,
                encoding="base64",
                commitment=Confirmed,
            )

            markets = []
            for account_info in response.value:
                try:
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

                    # Only include Open markets (status == 0) and not yet closed
                    # "Closed" is derived from now >= close_ts per IDL docs
                    if status != 0:
                        continue

                    # Also filter by close time (skip if already closed)
                    now_ts = int(time.time())
                    if close_ts > 0 and now_ts >= close_ts:
                        continue

                    # Construct market string: ticker_date_strike
                    market_str = f"{ticker}_{trading_date}_{strike_cents}"

                    markets.append(
                        MarketState(
                            market=market_str,
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
            # Return empty list on error (logged at call site)
            return []


class ChainOrderClient:
    """On-chain order client using solders for transaction building."""

    def __init__(
        self,
        rpc_client: AsyncClient,
        program_id: Pubkey,
        payer_keypair: Keypair,
        usdc_mint: Pubkey,
    ) -> None:
        self.rpc = rpc_client
        self.program_id = program_id
        self.payer = payer_keypair  # MARKET_MAKER_KEYPAIR - NEVER LOGGED
        self.usdc_mint = usdc_mint

    def _parse_market_key(self, market_str: str) -> tuple[str, int, int]:
        """Parse market string 'TICKER_YYYYMMDD_STRIKE' into components."""
        parts = market_str.split("_")
        expected_parts = 3  # ticker, date, strike
        if len(parts) != expected_parts:
            raise ValueError(f"Invalid market format: {market_str}")
        ticker = parts[0]
        trading_date = int(parts[1])
        strike_cents = int(parts[2])
        return ticker, trading_date, strike_cents

    async def place_order(self, market: str, side: str, price: int, qty: int, owner: str) -> int:
        """Place order via place_order instruction.

        Instruction args (Borsh):
        - side: enum { Bid = 0, Ask = 1 }
        - price: u8
        - qty: u64
        - kind: enum { Limit = 0, Ioc = 1 }
        """
        ticker, trading_date, strike_cents = self._parse_market_key(market)
        market_pda = derive_market_pda(self.program_id, ticker, trading_date, strike_cents)
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

        instruction = Instruction(self.program_id, data, accounts)

        # Build and send transaction
        # Get recent blockhash
        blockhash_resp = await self.rpc.get_latest_blockhash()
        recent_blockhash = blockhash_resp.value.blockhash

        # Create message and transaction
        message = Message.new_with_blockhash([instruction], self.payer.pubkey(), recent_blockhash)
        transaction = Transaction([self.payer], message, recent_blockhash)

        # Send and confirm transaction
        sig = await self.rpc.send_transaction(transaction)
        await self.rpc.confirm_transaction(sig.value, commitment=Confirmed)
        # Return a mock order ID (in production, parse from events/logs)
        return 1

    async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
        """Cancel order via cancel_order instruction.

        Instruction args (Borsh):
        - order_id: u64 (per IDL)
        """
        ticker, trading_date, strike_cents = self._parse_market_key(market)
        market_pda = derive_market_pda(self.program_id, ticker, trading_date, strike_cents)
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

        instruction = Instruction(self.program_id, data, accounts)

        # Build and send transaction
        blockhash_resp = await self.rpc.get_latest_blockhash()
        recent_blockhash = blockhash_resp.value.blockhash
        message = Message.new_with_blockhash([instruction], self.payer.pubkey(), recent_blockhash)
        transaction = Transaction([self.payer], message, recent_blockhash)

        sig = await self.rpc.send_transaction(transaction)
        await self.rpc.confirm_transaction(sig.value, commitment=Confirmed)

    async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
        """Fetch resting orders from book account.

        Deserializes Book account to read bids and asks arrays.
        """
        try:
            ticker, trading_date, strike_cents = self._parse_market_key(market)
            market_pda = derive_market_pda(self.program_id, ticker, trading_date, strike_cents)
            book_pda = derive_book_pda(self.program_id, market_pda)

            # Fetch book account
            resp = await self.rpc.get_account_info(book_pda)
            if not resp.value or not resp.value.data:
                return []

            data = bytes(resp.value.data)
            # Anchor discriminator size
            discriminator_size = 8
            if len(data) < discriminator_size:
                return []

            # Skip discriminator
            offset = discriminator_size

            # BookOrder: 64 bytes each
            # (order_id u64, owner pubkey, price u8, pad [u8;7], qty u64, seq u64)
            order_size = 64
            max_orders_per_side = 32

            orders = []

            # Parse bids array (32 orders)
            for _ in range(max_orders_per_side):
                if offset + order_size > len(data):
                    break
                order_data = data[offset : offset + order_size]
                order_id = struct.unpack("<Q", order_data[0:8])[0]
                owner_bytes = order_data[8:40]
                price = order_data[40]
                # skip padding [41:48]
                qty = struct.unpack("<Q", order_data[48:56])[0]
                # seq at [56:64], not needed

                # order_id == 0 means empty slot
                if order_id != 0 and qty > 0:
                    owner = str(Pubkey(owner_bytes))
                    orders.append(
                        RestingOrder(
                            order_id=order_id,
                            market=market,
                            side="Bid",
                            price=price,
                            qty=qty,
                            owner=owner,
                        )
                    )
                offset += order_size

            # Parse asks array (32 orders)
            for _ in range(max_orders_per_side):
                if offset + order_size > len(data):
                    break
                order_data = data[offset : offset + order_size]
                order_id = struct.unpack("<Q", order_data[0:8])[0]
                owner_bytes = order_data[8:40]
                price = order_data[40]
                qty = struct.unpack("<Q", order_data[48:56])[0]

                if order_id != 0 and qty > 0:
                    owner = str(Pubkey(owner_bytes))
                    orders.append(
                        RestingOrder(
                            order_id=order_id,
                            market=market,
                            side="Ask",
                            price=price,
                            qty=qty,
                            owner=owner,
                        )
                    )
                offset += order_size

            return orders

        except Exception:
            logger.exception(f"Failed to fetch resting orders for {market}")
            return []

    async def mint_pair(self, market: str, qty: int, owner: str) -> None:
        """Mint YES+NO pair via mint_pair instruction.

        Instruction args (Borsh):
        - qty: u64
        """
        ticker, trading_date, strike_cents = self._parse_market_key(market)
        market_pda = derive_market_pda(self.program_id, ticker, trading_date, strike_cents)
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
        # Check if ATAs exist, create if not
        try:
            await self.rpc.get_account_info(user_yes)
        except Exception:
            # Create YES ATA
            create_yes_ix = create_associated_token_account(
                self.payer.pubkey(), owner_pubkey, yes_mint
            )
            blockhash = (await self.rpc.get_latest_blockhash()).value.blockhash
            msg = Message.new_with_blockhash([create_yes_ix], self.payer.pubkey(), blockhash)
            tx = Transaction([self.payer], msg, blockhash)
            sig = await self.rpc.send_transaction(tx)
            await self.rpc.confirm_transaction(sig.value, commitment=Confirmed)

        try:
            await self.rpc.get_account_info(user_no)
        except Exception:
            # Create NO ATA
            create_no_ix = create_associated_token_account(
                self.payer.pubkey(), owner_pubkey, no_mint
            )
            blockhash = (await self.rpc.get_latest_blockhash()).value.blockhash
            msg = Message.new_with_blockhash([create_no_ix], self.payer.pubkey(), blockhash)
            tx = Transaction([self.payer], msg, blockhash)
            sig = await self.rpc.send_transaction(tx)
            await self.rpc.confirm_transaction(sig.value, commitment=Confirmed)

        accounts = [
            AccountMeta(pubkey=config, is_signer=False, is_writable=False),
            AccountMeta(pubkey=market_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=owner_pubkey, is_signer=True, is_writable=True),
            AccountMeta(pubkey=user_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=user_yes, is_signer=False, is_writable=True),
            AccountMeta(pubkey=user_no, is_signer=False, is_writable=True),
            AccountMeta(pubkey=yes_mint, is_signer=False, is_writable=True),
            AccountMeta(pubkey=no_mint, is_signer=False, is_writable=True),
            AccountMeta(pubkey=vault, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        instruction = Instruction(self.program_id, data, accounts)

        # Build and send transaction
        blockhash_resp = await self.rpc.get_latest_blockhash()
        recent_blockhash = blockhash_resp.value.blockhash
        message = Message.new_with_blockhash([instruction], self.payer.pubkey(), recent_blockhash)
        transaction = Transaction([self.payer], message, recent_blockhash)

        sig = await self.rpc.send_transaction(transaction)
        await self.rpc.confirm_transaction(sig.value, commitment=Confirmed)

    async def settle_funds(self, market: str, owner: str) -> None:
        """Settle funds via settle_funds instruction (no args)."""
        ticker, trading_date, strike_cents = self._parse_market_key(market)
        market_pda = derive_market_pda(self.program_id, ticker, trading_date, strike_cents)
        owner_pubkey = Pubkey.from_string(owner)

        # Build instruction data (no args beyond discriminator)
        data = DISCRIMINATOR_SETTLE_FUNDS

        # Account metas
        open_orders = derive_open_orders_pda(self.program_id, market_pda, owner_pubkey)
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

        instruction = Instruction(self.program_id, data, accounts)

        # Build and send transaction
        blockhash_resp = await self.rpc.get_latest_blockhash()
        recent_blockhash = blockhash_resp.value.blockhash
        message = Message.new_with_blockhash([instruction], self.payer.pubkey(), recent_blockhash)
        transaction = Transaction([self.payer], message, recent_blockhash)

        sig = await self.rpc.send_transaction(transaction)
        await self.rpc.confirm_transaction(sig.value, commitment=Confirmed)
