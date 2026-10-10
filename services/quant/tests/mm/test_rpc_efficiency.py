"""P1-7: MM RPC efficiency.

AC (issue #67): MM RPC calls down >= 50%. Measured with `CountingRpc` (tests/mm/counting_rpc.py),
a counting fake RPC that serves a steady-state devnet day of 7 tickers x 11 strikes = 77 markets.

Baseline (pre-P1-7 loop, origin/main 7620e2a) per loop iteration, derived from that code and
confirmed by replaying this same harness against it:

    getProgramAccounts                      1
    per market reads                       10  (cancel Book, OpenOrders check, 2x YES/NO
                                                 getAccountInfo + 2x getTokenAccountBalance,
                                                 quote Book, 2x Book inside place_order,
                                                 coverage Book)
    per transaction (5 per market)     2 + p  (getLatestBlockhash, sendTransaction, and p
                                                 getSignatureStatuses polls in
                                                 AsyncClient.confirm_transaction)

Replay measurements (77 markets, 100 ms per RPC call):

    confirm latency   p   before/iter   after/iter   before/min   after/min
    0.4 s             2   2311          796          323.5        121.7
    0.8 s             3   2696          796          245.2        121.7
    1.5 s             4   3081          1196         207.6         96.9

P1-MM-REQUOTE (per-market requote) trades the batched balance and quote-phase Book reads for
one balance read and one Book read per market (fresh just before that market's place):
+2 reads per market, still under half of the pre-P1-7 calls (same harness):

    confirm latency   p   before/iter   after/iter   share of before
    0.4 s             2   2311          947          41%
    0.8 s             3   2696          947          35%
    1.5 s             4   3081          1347         44%
"""

import json
import math
from typing import cast
from unittest.mock import AsyncMock, MagicMock

import pytest
from hypothesis import given
from hypothesis import strategies as st
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Finalized
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.rpc.config import RpcAccountInfoConfig, RpcProgramAccountsConfig
from solders.rpc.filter import Memcmp
from solders.rpc.requests import GetProgramAccounts
from solders.transaction_status import TransactionConfirmationStatus

from meridian_quant.mm.chain import (
    MARKET_DISCRIMINATOR,
    MAX_MULTIPLE_ACCOUNTS,
    TOKEN_PROGRAM_ID,
    ChainMarketSource,
    ChainOrderClient,
    ConfirmationTimeoutError,
    Timing,
    TransactionFailedError,
    b58encode,
    chunked,
    derive_book_pda,
    derive_open_orders_pda,
    derive_yes_mint_pda,
    get_associated_token_address,
    parse_token_amount,
)
from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource
from meridian_quant.mm.loop import MarketMakerLoop

from .counting_rpc import (
    SIM_NOW,
    STRIKES_PER_TICKER,
    TICKERS,
    CountingRpc,
    FakeAccount,
    FakeResp,
    FakeStatus,
    b58decode,
    book_data,
    seed_world,
    token_account_data,
)

PROGRAM_ID = Pubkey.from_string("11111111111111111111111111111112")
USDC_MINT = Pubkey.from_string("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
N_MARKETS = len(TICKERS) * STRIKES_PER_TICKER  # 77
TX_PER_MARKET = 5  # 2 cancels + settle + bid + ask (steady state, no mints)


def legacy_calls_per_iteration(n_markets: int, polls_per_confirm: int) -> int:
    """RPC calls per iteration of the pre-P1-7 loop (see module docstring)."""
    return 1 + 10 * n_markets + TX_PER_MARKET * n_markets * (2 + polls_per_confirm)


def _world(confirm_after_secs: float = 0.8) -> tuple[CountingRpc, Keypair]:
    owner = Keypair()
    rpc = CountingRpc(PROGRAM_ID, owner.pubkey(), confirm_after_secs=confirm_after_secs)
    seed_world(rpc, TICKERS, STRIKES_PER_TICKER)
    return rpc, owner


def _client(rpc: CountingRpc, owner: Keypair) -> ChainOrderClient:
    timing = Timing(sleep=rpc.sleep, monotonic=rpc.monotonic)
    return ChainOrderClient(cast(AsyncClient, rpc), PROGRAM_ID, owner, USDC_MINT, timing)


def _loop(rpc: CountingRpc, owner: Keypair) -> MarketMakerLoop:
    config = MMConfig.model_validate(
        {
            "market_maker_keypair": json.dumps(list(bytes(owner))),
            "program_id": str(PROGRAM_ID),
            "usdc_mint": str(USDC_MINT),
            "service_token": "test_token",
        }
    )
    return MarketMakerLoop(
        config,
        ChainMarketSource(cast(AsyncClient, rpc), PROGRAM_ID),
        FakeFairValueSource(rpc.fair_values()),
        _client(rpc, owner),
        clock=lambda: SIM_NOW,
    )


# --- AC: >= 50% fewer RPC calls ------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("confirm_after_secs", "legacy_polls"), [(0.4, 2), (0.8, 3), (1.5, 4)])
async def test_ac_rpc_calls_per_iteration_down_at_least_half(
    monkeypatch: pytest.MonkeyPatch, confirm_after_secs: float, legacy_polls: int
) -> None:
    """AC: steady-state iteration over 77 markets uses <= 50% of the pre-P1-7 RPC calls."""
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)
    rpc, owner = _world(confirm_after_secs)
    loop = _loop(rpc, owner)

    await loop._run_once()  # warm-up: learns which OpenOrders accounts exist
    rpc.reset_counts()
    await loop._run_once()

    before = legacy_calls_per_iteration(N_MARKETS, legacy_polls)
    after = rpc.total_calls
    assert after <= before / 2, f"{after} calls vs {before} before ({dict(rpc.calls)})"

    # Same trading work as before P1-7: every market cancelled, settled and re-quoted.
    assert rpc.calls["sendTransaction"] == TX_PER_MARKET * N_MARKETS
    assert loop.book_coverage == 1.0
    # 1 gPA; 2 batched Book reads (cancel listing, coverage); and, since P1-MM-REQUOTE
    # requotes market by market, 2 single-market reads per market (balances after its settle,
    # Book just before its place).
    assert rpc.calls["getProgramAccounts"] == 1
    assert rpc.calls["getMultipleAccounts"] == 2 * math.ceil(N_MARKETS / 100) + 2 * N_MARKETS
    assert rpc.calls["getAccountInfo"] == 0
    assert rpc.calls["getTokenAccountBalance"] == 0
    assert max(rpc.gma_batch_sizes) <= MAX_MULTIPLE_ACCOUNTS


@pytest.mark.asyncio
async def test_steady_state_cost_per_transaction(monkeypatch: pytest.MonkeyPatch) -> None:
    """At ~2-slot confirmation each transaction costs one send + one status poll."""
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)
    rpc, owner = _world(confirm_after_secs=0.8)
    loop = _loop(rpc, owner)
    await loop._run_once()
    rpc.reset_counts()
    start = rpc.now
    await loop._run_once()

    txs = rpc.calls["sendTransaction"]
    assert rpc.calls["getSignatureStatuses"] == txs
    # One blockhash per 20 s of cycle at most (vs one per transaction before)
    assert rpc.calls["getLatestBlockhash"] <= math.ceil((rpc.now - start) / 20.0) + 1
    assert rpc.calls["getLatestBlockhash"] < txs / 10


@pytest.mark.asyncio
async def test_first_iteration_checks_open_orders_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """OpenOrders existence is read once per market, then cached (never closed on-chain)."""
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)
    rpc, owner = _world()
    loop = _loop(rpc, owner)
    await loop._run_once()
    assert rpc.calls["getAccountInfo"] == N_MARKETS
    rpc.reset_counts()
    await loop._run_once()
    assert rpc.calls["getAccountInfo"] == 0


# --- getProgramAccounts memcmp filter --------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_open_markets_filters_by_discriminator_server_side() -> None:
    """The memcmp filter is base58 and selects only Market accounts (1 call)."""
    rpc, _owner = _world()
    source = ChainMarketSource(cast(AsyncClient, rpc), PROGRAM_ID)

    markets = await source.fetch_open_markets()

    assert len(markets) == N_MARKETS
    assert rpc.calls["getProgramAccounts"] == 1
    (filters,) = rpc.gpa_filters
    assert isinstance(filters, list) and len(filters) == 1
    assert getattr(filters[0], "offset", None) == 0
    assert b58decode(getattr(filters[0], "bytes", "")) == MARKET_DISCRIMINATOR


def test_memcmp_filter_serializes_as_base58_discriminator() -> None:
    """solders sends MemcmpOpts.bytes with encoding=base58; it must decode to the discriminator."""
    memcmp = Memcmp(offset=0, bytes_=b58encode(MARKET_DISCRIMINATOR))
    config = RpcProgramAccountsConfig(RpcAccountInfoConfig(), filters=[memcmp])
    body = json.loads(GetProgramAccounts(PROGRAM_ID, config).to_json())
    wire = body["params"][1]["filters"][0]["memcmp"]
    assert wire["encoding"] == "base58"
    assert b58decode(wire["bytes"]) == MARKET_DISCRIMINATOR


@pytest.mark.asyncio
async def test_fetch_open_markets_propagates_rpc_errors() -> None:
    rpc = AsyncMock(spec=AsyncClient)
    rpc.get_program_accounts.side_effect = Exception("429 Too Many Requests")
    with pytest.raises(Exception, match="429"):
        await ChainMarketSource(rpc, PROGRAM_ID).fetch_open_markets()


# --- base58 / chunking / token parsing (property-based) ----------------------------------------


@given(st.binary(max_size=64))
def test_b58encode_round_trips(data: bytes) -> None:
    assert b58decode(b58encode(data)) == data


@given(st.binary(min_size=32, max_size=32))
def test_b58encode_matches_solders_pubkey(data: bytes) -> None:
    assert b58encode(data) == str(Pubkey(data))


@given(st.lists(st.integers(), max_size=450), st.integers(min_value=1, max_value=120))
def test_chunked_partitions_in_order(items: list[int], size: int) -> None:
    chunks = list(chunked(items, size))
    assert [x for chunk in chunks for x in chunk] == items
    assert all(1 <= len(chunk) <= size for chunk in chunks)
    assert len(chunks) == math.ceil(len(items) / size)


@pytest.mark.parametrize("size", [0, -1])
def test_chunked_rejects_non_positive_size(size: int) -> None:
    with pytest.raises(ValueError, match="positive"):
        list(chunked([1, 2], size))


@given(st.integers(min_value=0, max_value=2**64 - 1), st.binary(min_size=32, max_size=32))
def test_parse_token_amount_reads_u64_at_offset_64(amount: int, mint: bytes) -> None:
    owner = Pubkey(bytes(32))
    account = FakeAccount(token_account_data(Pubkey(mint), owner, amount), TOKEN_PROGRAM_ID)
    assert parse_token_amount(account) == amount


def test_parse_token_amount_missing_account_is_zero() -> None:
    assert parse_token_amount(None) == 0


@pytest.mark.parametrize(
    ("data", "owner", "match"),
    [
        (bytes(165), PROGRAM_ID, "not an SPL token account"),
        (bytes(40), TOKEN_PROGRAM_ID, "too short"),
    ],
)
def test_parse_token_amount_rejects_non_token_accounts(
    data: bytes, owner: Pubkey, match: str
) -> None:
    with pytest.raises(ValueError, match=match):
        parse_token_amount(FakeAccount(data, owner))


# --- batched reads -------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_token_balances_batched_and_chunked_at_100_keys() -> None:
    """77 markets -> 154 ATAs -> 2 getMultipleAccounts calls (100 + 54); amounts correct."""
    rpc, owner = _world()
    client = _client(rpc, owner)
    markets = [m.market for m in rpc.markets]

    balances = await client.get_multiple_token_balances(markets, str(owner.pubkey()))

    assert balances == {m: (100, 90) for m in markets}
    assert rpc.gma_batch_sizes == [100, 54]
    assert rpc.total_calls == 2


@pytest.mark.asyncio
async def test_token_balances_missing_ata_reads_zero() -> None:
    rpc, owner = _world()
    market = rpc.markets[0].market
    yes_mint = derive_yes_mint_pda(PROGRAM_ID, Pubkey.from_string(market))
    del rpc.accounts[get_associated_token_address(yes_mint, owner.pubkey())]

    balances = await _client(rpc, owner).get_multiple_token_balances([market], str(owner.pubkey()))

    assert balances == {market: (0, 90)}


@pytest.mark.asyncio
async def test_token_balances_invalid_account_skips_only_that_market() -> None:
    rpc, owner = _world()
    bad, good = rpc.markets[0].market, rpc.markets[1].market
    yes_mint = derive_yes_mint_pda(PROGRAM_ID, Pubkey.from_string(bad))
    rpc.accounts[get_associated_token_address(yes_mint, owner.pubkey())] = FakeAccount(
        bytes(165), PROGRAM_ID
    )

    balances = await _client(rpc, owner).get_multiple_token_balances(
        [bad, good], str(owner.pubkey())
    )

    assert balances == {good: (100, 90)}


@pytest.mark.asyncio
async def test_token_balances_rpc_error_raises() -> None:
    """Fail loudly: an RPC error must not turn into an empty/partial result."""
    rpc = AsyncMock(spec=AsyncClient)
    rpc.get_multiple_accounts.side_effect = Exception("RPC timeout")
    client = ChainOrderClient(rpc, PROGRAM_ID, Keypair(), USDC_MINT)
    market = str(Keypair().pubkey())
    with pytest.raises(Exception, match="RPC timeout"):
        await client.get_multiple_token_balances([market], str(Keypair().pubkey()))


@pytest.mark.asyncio
async def test_short_get_multiple_accounts_response_raises() -> None:
    rpc = AsyncMock(spec=AsyncClient)
    rpc.get_multiple_accounts.return_value = FakeResp([None])
    client = ChainOrderClient(rpc, PROGRAM_ID, Keypair(), USDC_MINT)
    markets = [str(Keypair().pubkey()) for _ in range(2)]
    with pytest.raises(RuntimeError, match="returned 1 accounts for 2 keys"):
        await client.fetch_resting_orders_batch(markets)


@pytest.mark.asyncio
async def test_books_batched_parsed_and_missing_book_is_empty() -> None:
    rpc, owner = _world()
    client = _client(rpc, owner)
    markets = [m.market for m in rpc.markets]
    missing = markets[3]
    del rpc.accounts[derive_book_pda(PROGRAM_ID, Pubkey.from_string(missing))]

    books = await client.fetch_resting_orders_batch(markets)

    assert rpc.gma_batch_sizes == [77]
    assert books[missing] == []
    first = books[markets[0]]
    assert [(o.side, o.price, o.qty, o.owner) for o in first] == [
        ("Bid", 48, 10, str(owner.pubkey())),
        ("Ask", 52, 10, str(owner.pubkey())),
    ]


@pytest.mark.asyncio
async def test_books_chunked_for_more_than_100_markets() -> None:
    owner = Keypair()
    rpc = CountingRpc(PROGRAM_ID, owner.pubkey())
    seed_world(rpc, [f"T{i}" for i in range(25)], 10)  # 250 markets
    books = await _client(rpc, owner).fetch_resting_orders_batch([m.market for m in rpc.markets])
    assert len(books) == 250
    assert rpc.gma_batch_sizes == [100, 100, 50]


@pytest.mark.asyncio
async def test_single_book_read_still_supported() -> None:
    rpc, owner = _world()
    market = rpc.markets[0].market
    orders = await _client(rpc, owner).fetch_resting_orders(market)
    assert len(orders) == 2
    rpc.accounts[derive_book_pda(PROGRAM_ID, Pubkey.from_string(market))] = FakeAccount(
        book_data([], []), PROGRAM_ID
    )
    assert await _client(rpc, owner).fetch_resting_orders(market) == []


# --- transactions: blockhash reuse, confirmation, snapshots ---------------------------------


def _noop_ix() -> Instruction:
    return Instruction(PROGRAM_ID, b"", [])


@pytest.mark.asyncio
async def test_blockhash_reused_within_cycle_and_refreshed_per_cycle_and_ttl() -> None:
    rpc, owner = _world()
    client = _client(rpc, owner)
    market = rpc.markets[0].market
    me = str(owner.pubkey())

    client.begin_cycle()
    await client.cancel_order(market, 1, me)
    await client.cancel_order(market, 2, me)
    assert rpc.calls["getLatestBlockhash"] == 1

    # Next cycle re-sends an identical transaction: fresh blockhash -> distinct signature
    client.begin_cycle()
    await client.cancel_order(market, 1, me)
    assert rpc.calls["getLatestBlockhash"] == 2

    await rpc.sleep(25.0)  # past BLOCKHASH_TTL_SECS within one cycle
    await client.cancel_order(market, 3, me)
    assert rpc.calls["getLatestBlockhash"] == 3


@pytest.mark.asyncio
async def test_confirmation_waits_for_requested_commitment() -> None:
    rpc, owner = _world(confirm_after_secs=0.0)
    statuses = [
        FakeStatus(None, None),
        FakeStatus(TransactionConfirmationStatus.Processed, None),
        FakeStatus(TransactionConfirmationStatus.Confirmed, None),
        FakeStatus(TransactionConfirmationStatus.Finalized, None),
    ]

    async def scripted(*_a: object, **_k: object) -> FakeResp:
        rpc.calls["getSignatureStatuses"] += 1
        return FakeResp([statuses.pop(0)])

    rpc.get_signature_statuses = scripted  # type: ignore[method-assign]
    client = _client(rpc, owner)
    await client._send_and_confirm([_noop_ix()], commitment=Finalized)
    assert rpc.calls["getSignatureStatuses"] == 4
    assert statuses == []


@pytest.mark.asyncio
async def test_onchain_failure_raises() -> None:
    rpc, owner = _world()

    async def failed(*_a: object, **_k: object) -> FakeResp:
        return FakeResp([FakeStatus(TransactionConfirmationStatus.Confirmed, "Custom(6001)")])

    rpc.get_signature_statuses = failed  # type: ignore[method-assign]
    with pytest.raises(TransactionFailedError, match="Custom"):
        await _client(rpc, owner).cancel_order(rpc.markets[0].market, 1, str(owner.pubkey()))


@pytest.mark.asyncio
async def test_unconfirmed_transaction_times_out() -> None:
    rpc, owner = _world(confirm_after_secs=10_000.0)
    with pytest.raises(ConfirmationTimeoutError, match="not confirmed"):
        await _client(rpc, owner).cancel_order(rpc.markets[0].market, 1, str(owner.pubkey()))
    assert rpc.now >= 90.0


@pytest.mark.asyncio
async def test_place_order_uses_snapshot_instead_of_book_read() -> None:
    rpc, owner = _world()
    client = _client(rpc, owner)
    market = rpc.markets[0].market
    me = str(owner.pubkey())

    await client.place_order(market, "Bid", 48, 10, me, resting_orders=[])
    assert rpc.calls["getAccountInfo"] == 0
    await client.place_order(market, "Ask", 52, 10, me)
    assert rpc.calls["getAccountInfo"] == 1


@pytest.mark.asyncio
async def test_settle_skips_missing_open_orders_and_rechecks() -> None:
    rpc, owner = _world()
    client = _client(rpc, owner)
    market = rpc.markets[0].market
    me = str(owner.pubkey())
    oo = derive_open_orders_pda(PROGRAM_ID, Pubkey.from_string(market), owner.pubkey())
    saved = rpc.accounts.pop(oo)

    await client.settle_funds(market, me)
    await client.settle_funds(market, me)
    assert rpc.calls["getAccountInfo"] == 2  # not cached while missing
    assert rpc.calls["sendTransaction"] == 0

    rpc.accounts[oo] = saved
    await client.settle_funds(market, me)
    client.begin_cycle()  # settle runs once per market per cycle
    await client.settle_funds(market, me)
    assert rpc.calls["getAccountInfo"] == 3  # cached once seen
    assert rpc.calls["sendTransaction"] == 2


@pytest.mark.asyncio
async def test_balance_helpers_read_account_once() -> None:
    rpc, owner = _world()
    client = _client(rpc, owner)
    market = rpc.markets[0].market
    me = str(owner.pubkey())
    assert await client.get_yes_token_balance(market, me) == 100
    assert await client.get_no_token_balance(market, me) == 90
    assert rpc.calls["getAccountInfo"] == 2
    assert rpc.calls["getTokenAccountBalance"] == 0


@pytest.mark.asyncio
async def test_mint_pair_creates_missing_atas_then_mints() -> None:
    rpc, owner = _world(confirm_after_secs=0.0)
    client = _client(rpc, owner)
    market = rpc.markets[0].market
    yes_mint = derive_yes_mint_pda(PROGRAM_ID, Pubkey.from_string(market))
    del rpc.accounts[get_associated_token_address(yes_mint, owner.pubkey())]

    await client.mint_pair(market, 10, str(owner.pubkey()))

    # create YES ATA + mint_pair; NO ATA already exists
    assert rpc.calls["sendTransaction"] == 2


# --- loop: fail loudly / closed on batched read errors --------------------------------------


@pytest.mark.asyncio
async def test_loop_book_read_failure_cancels_and_places_nothing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A failed batched Book read aborts the iteration loudly; no blind orders."""
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)
    rpc, owner = _world()
    loop = _loop(rpc, owner)

    async def broken(*_a: object, **_k: object) -> FakeResp:
        raise ConnectionError("RPC down")

    rpc.get_multiple_accounts = broken  # type: ignore[method-assign]
    await loop._run_once()

    assert rpc.calls["sendTransaction"] == 0
    assert loop.book_coverage == 0.0
    assert "Batched Book read failed" in caplog.text


@pytest.mark.asyncio
async def test_loop_skips_market_with_unreadable_balances(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A corrupt ATA for one market keeps only that market unquoted."""
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)
    rpc, owner = _world()
    loop = _loop(rpc, owner)
    bad = rpc.markets[0].market
    yes_mint = derive_yes_mint_pda(PROGRAM_ID, Pubkey.from_string(bad))
    rpc.accounts[get_associated_token_address(yes_mint, owner.pubkey())] = FakeAccount(
        bytes(165), PROGRAM_ID
    )

    await loop._run_once()

    # 77 cancels x2 + 77 settles, then quotes for the 76 readable markets only
    assert rpc.calls["sendTransaction"] == 2 * N_MARKETS + N_MARKETS + 2 * (N_MARKETS - 1)
    assert f"Token balances unreadable for {bad}" in caplog.text


@pytest.mark.asyncio
async def test_loop_coverage_zero_when_a_book_is_unreadable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)
    rpc, owner = _world()
    loop = _loop(rpc, owner)
    real = rpc.get_multiple_accounts
    calls = 0

    async def fail_coverage(*args: object, **kwargs: object) -> FakeResp:
        nonlocal calls
        calls += 1
        # cancel-listing books, then balances + books per market, then coverage books
        if calls == 2 + 2 * N_MARKETS:
            raise ConnectionError("RPC down")
        return await real(*args, **kwargs)  # type: ignore[arg-type]

    rpc.get_multiple_accounts = fail_coverage  # type: ignore[method-assign]
    await loop._run_once()
    assert rpc.calls["sendTransaction"] > 0
    assert loop.book_coverage == 0.0


@pytest.mark.asyncio
async def test_start_does_not_log_rpc_url(caplog: pytest.LogCaptureFixture) -> None:
    """A dedicated RPC URL embeds its API key; the loop must not log it."""
    owner = Keypair()
    config = MMConfig.model_validate(
        {
            "market_maker_keypair": json.dumps(list(bytes(owner))),
            "program_id": str(PROGRAM_ID),
            "usdc_mint": str(USDC_MINT),
            "service_token": "test_token",
            "rpc_url": "https://devnet.example.invalid/?api-key=SECRET123",
            "loop_interval_secs": 0.0,
        }
    )
    loop = MarketMakerLoop(config, MagicMock(), MagicMock(), MagicMock(), clock=lambda: SIM_NOW)

    async def stop_now() -> None:
        await loop.stop()

    loop._run_once = stop_now  # type: ignore[method-assign]
    with caplog.at_level("DEBUG"):
        await loop.start()

    assert any("Starting market maker loop" in r.getMessage() for r in caplog.records)
    assert all("SECRET123" not in repr(r.__dict__) for r in caplog.records)
