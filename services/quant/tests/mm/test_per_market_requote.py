"""P1-MM-REQUOTE: the MM requotes market by market so a book is never empty for long.

Each tick does, per market: cancel its MM orders -> settle -> sync its inventory (mint if
short) -> place its new quote, and only then moves to the next market. A market's book is
empty only during its own few transactions instead of for most of a multi-minute tick.
"""

import json
from datetime import UTC, datetime, timedelta

import pytest
from solders.keypair import Keypair

from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.loop import FAIR_VALUE_REFRESH_SECS, MarketMakerLoop
from meridian_quant.mm.types import FairValue, MarketState, RestingOrder

START = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)  # Thu 14:00 ET
SESSION = 20261008
TX_OPS = ("cancel", "settle", "mint", "place")


class SimClock:
    """A mutable clock the fake order client advances on every transaction."""

    def __init__(self, now: datetime = START) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, secs: float) -> None:
        self.now += timedelta(seconds=secs)


class TimedOrderClient(FakeOrderClient):
    """FakeOrderClient whose transactions each take `tx_secs` of simulated time."""

    def __init__(self, clock: SimClock, tx_secs: float) -> None:
        super().__init__()
        self._clock = clock
        self._tx_secs = tx_secs

    async def place_order(  # noqa: PLR0913, PLR0917 - OrderClient signature
        self,
        market: str,
        side: str,
        price: int,
        qty: int,
        owner: str,
        resting_orders: list[RestingOrder] | None = None,
    ) -> int:
        self._clock.advance(self._tx_secs)
        return await super().place_order(market, side, price, qty, owner, resting_orders)

    async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
        self._clock.advance(self._tx_secs)
        await super().cancel_order(market, order_id, owner)

    async def settle_funds(self, market: str, owner: str) -> None:
        self._clock.advance(self._tx_secs)
        await super().settle_funds(market, owner)

    async def mint_pair(self, market: str, qty: int, owner: str) -> None:
        self._clock.advance(self._tx_secs)
        await super().mint_pair(market, qty, owner)


class LiveFairValueSource:
    """Fair values stamped with the current clock; counts reads; can turn stale or fail."""

    def __init__(self, markets: list[MarketState], clock: SimClock) -> None:
        self._markets = markets
        self._clock = clock
        self.fetches = 0
        self.stale_after_fetch: int | None = None
        self.fail_after_fetch: int | None = None

    async def fetch_fair_values(self) -> list[FairValue]:
        self.fetches += 1
        if self.fail_after_fetch is not None and self.fetches > self.fail_after_fetch:
            raise ConnectionError("fair value source down")
        stale = self.stale_after_fetch is not None and self.fetches > self.stale_after_fetch
        return [_fv(m, self._clock(), stale=stale) for m in self._markets]


@pytest.fixture
def mm_config() -> MMConfig:
    return MMConfig.model_validate(
        {
            "market_maker_keypair": json.dumps(list(bytes(Keypair()))),
            "program_id": "11111111111111111111111111111112",
            "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            "service_token": "test_token",
        }
    )


@pytest.fixture(autouse=True)
def _no_demo_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)


def _market(strike: int, *, trading_date: int = SESSION, close_in_secs: int = 7200) -> MarketState:
    return MarketState(
        market=f"AAPL_{trading_date}_{strike}",
        ticker="AAPL",
        strike_cents=strike,
        trading_date=trading_date,
        close_ts=int(START.timestamp()) + close_in_secs,
        is_open=True,
        pairs_outstanding=0,
    )


def _fv(market: MarketState, as_of: datetime, *, stale: bool = False) -> FairValue:
    return FairValue(
        market=market.market,
        ticker=market.ticker,
        strike_cents=market.strike_cents,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=as_of,
        stale=stale,
    )


def _loop(
    config: MMConfig,
    markets: list[MarketState],
    client: FakeOrderClient,
    clock: SimClock,
    fair_values: LiveFairValueSource | FakeFairValueSource | None = None,
) -> MarketMakerLoop:
    source = fair_values or FakeFairValueSource([_fv(m, START) for m in markets])
    return MarketMakerLoop(config, FakeMarketSource(markets), source, client, clock=clock)


def _mm_orders(client: FakeOrderClient, market: MarketState, owner: str) -> list[RestingOrder]:
    return [o for o in client.get_all_orders().get(market.market, []) if o.owner == owner]


def _blocks(call_log: list[tuple[str, str]]) -> list[tuple[str, list[str]]]:
    """Group consecutive calls by market: [(market, [op, ...]), ...]."""
    blocks: list[tuple[str, list[str]]] = []
    for op, market in call_log:
        if blocks and blocks[-1][0] == market:
            blocks[-1][1].append(op)
        else:
            blocks.append((market, [op]))
    return blocks


def _interleaved_ops(call_log: list[tuple[str, str]], market: str) -> int:
    """Other markets' operations between `market`'s first cancel/settle and its last place."""
    indices = [i for i, (_op, m) in enumerate(call_log) if m == market]
    first, last = indices[0], indices[-1]
    return sum(1 for _op, m in call_log[first : last + 1] if m != market)


# --- ordering --------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_each_market_is_cancelled_and_requoted_before_the_next(mm_config: MMConfig) -> None:
    """AC: per market, cancel -> settle -> place happen adjacently; zero interleaving."""
    clock = SimClock()
    markets = [_market(s) for s in (22000, 23000, 24000, 25000)]
    client = FakeOrderClient()
    mm = _loop(mm_config, markets, client, clock)
    owner = str(mm.keypair.pubkey())

    await mm._run_once()  # first tick: no old quotes; mints, then places
    first = _blocks(client.call_log)
    assert first == [(m.market, ["settle", "mint", "place", "place"]) for m in markets]

    client.call_log.clear()
    await mm._run_once()  # steady state: old quotes cancelled and replaced market by market

    assert _blocks(client.call_log) == [
        (m.market, ["cancel", "cancel", "settle", "place", "place"]) for m in markets
    ]
    for m in markets:
        assert _interleaved_ops(client.call_log, m.market) == 0
        assert sorted(o.side for o in _mm_orders(client, m, owner)) == ["Ask", "Bid"]
    assert mm.book_coverage == 1.0


@pytest.mark.asyncio
async def test_prior_day_market_is_cancelled_and_settled_but_never_quoted_or_minted(
    mm_config: MMConfig,
) -> None:
    """AB-11: a prior-day market past close keeps cancel + settle; no mint, no place."""
    clock = SimClock()
    yesterday = _market(23000, trading_date=20261007, close_in_secs=-20 * 3600)
    today = _market(23000)
    client = FakeOrderClient()
    mm = _loop(mm_config, [yesterday, today], client, clock)
    owner = str(mm.keypair.pubkey())
    await client.place_order(yesterday.market, "Bid", 40, 10, owner)  # leftover from yesterday
    client.call_log.clear()

    await mm._run_once()

    assert _blocks(client.call_log) == [
        (yesterday.market, ["cancel", "settle"]),
        (today.market, ["settle", "mint", "place", "place"]),
    ]
    assert _mm_orders(client, yesterday, owner) == []
    assert mm.book_coverage == 1.0  # the prior-day market is not in the denominator


# --- failure isolation -----------------------------------------------------------------------


class FailingCancelClient(FakeOrderClient):
    def __init__(self, failing_market: str) -> None:
        super().__init__()
        self.failing_market = failing_market

    async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
        if market == self.failing_market:
            self.call_log.append(("cancel", market))
            raise ConnectionError("cancel tx failed")
        await super().cancel_order(market, order_id, owner)


@pytest.mark.asyncio
async def test_cancel_failure_on_one_market_does_not_block_the_others(
    mm_config: MMConfig, caplog: pytest.LogCaptureFixture
) -> None:
    """A market whose cancels fail is still settled; later markets are requoted normally."""
    clock = SimClock()
    a, b, c = (_market(s) for s in (22000, 23000, 24000))
    client = FailingCancelClient(a.market)
    mm = _loop(mm_config, [a, b, c], client, clock)
    owner = str(mm.keypair.pubkey())
    await mm._run_once()
    old_ids = {o.order_id for m in (b, c) for o in _mm_orders(client, m, owner)}
    client.call_log.clear()

    await mm._run_once()

    for m in (b, c):
        orders = _mm_orders(client, m, owner)
        assert sorted(o.side for o in orders) == ["Ask", "Bid"]
        assert not {o.order_id for o in orders} & old_ids  # replaced, not stacked
    blocks = dict(_blocks(client.call_log))
    assert blocks[a.market][:3] == ["cancel", "cancel", "settle"]
    # A's two uncancelled orders stay visible to the cap check: 2 old + 2 new <= 8
    assert len(_mm_orders(client, a, owner)) == 4
    assert "Failed to cancel order" in caplog.text


class ExplodingClient(FakeOrderClient):
    """Raises from one stage, only for one market, only on its per-market call."""

    def __init__(self, failing_market: str, stage: str) -> None:
        super().__init__()
        self.failing_market = failing_market
        self.stage = stage

    async def get_multiple_token_balances(
        self, markets: list[str], owner: str
    ) -> dict[str, tuple[int, int]]:
        if self.stage == "balances" and markets == [self.failing_market]:
            raise TimeoutError("balance read timed out")
        return await super().get_multiple_token_balances(markets, owner)

    async def fetch_resting_orders_batch(self, markets: list[str]) -> dict[str, list[RestingOrder]]:
        if self.stage == "book" and markets == [self.failing_market]:
            raise ConnectionError("book read failed")
        return await super().fetch_resting_orders_batch(markets)

    async def place_order(  # noqa: PLR0913, PLR0917 - OrderClient signature
        self,
        market: str,
        side: str,
        price: int,
        qty: int,
        owner: str,
        resting_orders: list[RestingOrder] | None = None,
    ) -> int:
        if self.stage == "place" and market == self.failing_market:
            raise RuntimeError("place tx failed")
        return await super().place_order(market, side, price, qty, owner, resting_orders)


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["balances", "book", "place"])
async def test_exception_on_one_market_does_not_abort_the_tick(
    mm_config: MMConfig, caplog: pytest.LogCaptureFixture, stage: str
) -> None:
    """An exception while requoting B is logged, B is skipped, A and C are still quoted."""
    clock = SimClock()
    a, b, c = (_market(s) for s in (22000, 23000, 24000))
    client = ExplodingClient(b.market, stage)
    mm = _loop(mm_config, [a, b, c], client, clock)
    owner = str(mm.keypair.pubkey())

    await mm._run_once()

    assert _mm_orders(client, b, owner) == []
    for m in (a, c):
        assert sorted(o.side for o in _mm_orders(client, m, owner)) == ["Ask", "Bid"]
    assert f"Requote failed for AAPL {b.market}" in caplog.text
    assert abs(mm.book_coverage - 2 / 3) < 1e-9


@pytest.mark.asyncio
async def test_unreadable_cancel_listing_skips_only_that_market(mm_config: MMConfig) -> None:
    """AB-10: a market missing from the cancel listing is settled but never quoted."""

    class MissingBookClient(FakeOrderClient):
        async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
            if market == b.market:
                raise ConnectionError("book unreadable")
            return await super().fetch_resting_orders(market)

    clock = SimClock()
    a, b = _market(22000), _market(23000)
    client = MissingBookClient()
    mm = _loop(mm_config, [a, b], client, clock)

    await mm._run_once()

    assert _blocks(client.call_log) == [
        (a.market, ["settle", "mint", "place", "place"]),
        (b.market, ["settle"]),
    ]


# --- fair values re-read mid-tick -----------------------------------------------------------


@pytest.mark.asyncio
async def test_fair_values_reread_once_older_than_refresh_window(mm_config: MMConfig) -> None:
    """Values are read once per tick and re-read only when a place would use >30 s old ones."""
    clock = SimClock()
    markets = [_market(22000 + 500 * i) for i in range(6)]
    client = TimedOrderClient(clock, tx_secs=4.0)  # first tick: 4 tx x 4 s = 16 s per market
    source = LiveFairValueSource(markets, clock)
    mm = _loop(mm_config, markets, client, clock, source)
    owner = str(mm.keypair.pubkey())

    await mm._run_once()

    # 6 markets x 16 s = 96 s of transactions: one tick-start read plus re-reads, each at
    # least FAIR_VALUE_REFRESH_SECS apart (never one per market)
    assert 2 <= source.fetches <= 1 + 96 // int(FAIR_VALUE_REFRESH_SECS)
    for m in markets:
        assert sorted(o.side for o in _mm_orders(client, m, owner)) == ["Ask", "Bid"]


@pytest.mark.asyncio
async def test_fair_values_not_reread_within_refresh_window(mm_config: MMConfig) -> None:
    clock = SimClock()
    markets = [_market(22000), _market(23000)]
    client = TimedOrderClient(clock, tx_secs=1.0)
    source = LiveFairValueSource(markets, clock)
    mm = _loop(mm_config, markets, client, clock, source)

    await mm._run_once()

    assert source.fetches == 1


@pytest.mark.asyncio
async def test_stale_value_on_reread_skips_the_remaining_markets(
    mm_config: MMConfig, caplog: pytest.LogCaptureFixture
) -> None:
    """A re-read value that is stale is re-checked per market: that market is not quoted."""
    clock = SimClock()
    markets = [_market(22000 + 500 * i) for i in range(4)]
    client = TimedOrderClient(clock, tx_secs=10.0)  # 40 s per market: re-read from market 2
    source = LiveFairValueSource(markets, clock)
    source.stale_after_fetch = 1
    mm = _loop(mm_config, markets, client, clock, source)
    owner = str(mm.keypair.pubkey())

    await mm._run_once()

    assert len(_mm_orders(client, markets[0], owner)) == 2
    for m in markets[1:]:
        assert _mm_orders(client, m, owner) == []
        assert ("mint", m.market) not in client.call_log  # skipped before minting
    assert "re-read fair value is stale" in caplog.text


@pytest.mark.asyncio
async def test_failed_reread_fails_closed(
    mm_config: MMConfig, caplog: pytest.LogCaptureFixture
) -> None:
    clock = SimClock()
    markets = [_market(22000), _market(23000)]
    client = TimedOrderClient(clock, tx_secs=10.0)
    source = LiveFairValueSource(markets, clock)
    source.fail_after_fetch = 1
    mm = _loop(mm_config, markets, client, clock, source)
    owner = str(mm.keypair.pubkey())

    await mm._run_once()

    assert len(_mm_orders(client, markets[0], owner)) == 2
    assert _mm_orders(client, markets[1], owner) == []
    assert "no fair value after re-read" in caplog.text


@pytest.mark.asyncio
async def test_spot_age_on_reread_uses_the_same_rule_as_the_pull_check(
    mm_config: MMConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Re-read values with old spot are stale unless the devnet demo flag waives spot age."""
    markets = [_market(22000), _market(23000)]
    for demo_flag, quoted in (("", False), ("1", True)):
        if demo_flag:
            monkeypatch.setenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", demo_flag)
            monkeypatch.setenv("SOLANA_CLUSTER", "devnet")
            monkeypatch.setenv("SOLANA_RPC_URL", "https://api.devnet.solana.com")
        clock = SimClock()
        client = TimedOrderClient(clock, tx_secs=10.0)
        # Values stamped at START: fresh for the tick-start check, 50 s old at the re-read
        mm = _loop(mm_config, markets, client, clock)
        owner = str(mm.keypair.pubkey())

        await mm._run_once()

        assert len(_mm_orders(client, markets[0], owner)) == 2
        assert (len(_mm_orders(client, markets[1], owner)) == 2) is quoted


# --- close window mid-tick -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_market_entering_close_window_mid_tick_is_not_quoted(mm_config: MMConfig) -> None:
    """min_time_to_close_secs is checked per market with the clock at that market's turn."""
    clock = SimClock()
    a, b = _market(22000, close_in_secs=150), _market(23000, close_in_secs=150)
    client = TimedOrderClient(clock, tx_secs=20.0)
    mm = _loop(mm_config, [a, b], client, clock, LiveFairValueSource([a, b], clock))
    owner = str(mm.keypair.pubkey())

    await mm._run_once()  # A: settle at +20 s (130 s left), quoted; B's turn at +100 s

    assert len(_mm_orders(client, a, owner)) == 2
    assert _blocks(client.call_log)[-1] == (b.market, ["settle"])  # no mint, no place


# --- per-market quote-phase guards ------------------------------------------------------------


@pytest.mark.asyncio
async def test_book_missing_on_fresh_read_is_not_quoted(
    mm_config: MMConfig, caplog: pytest.LogCaptureFixture
) -> None:
    """AB-10: the Book read just before placing omits B -> B is not quoted; A still is."""

    class MissingOnQuoteRead(FakeOrderClient):
        async def fetch_resting_orders_batch(
            self, markets: list[str]
        ) -> dict[str, list[RestingOrder]]:
            books = await super().fetch_resting_orders_batch(markets)
            if markets == [b.market]:
                books.pop(b.market)
            return books

    clock = SimClock()
    a, b = _market(22000), _market(23000)
    client = MissingOnQuoteRead()
    mm = _loop(mm_config, [a, b], client, clock)
    owner = str(mm.keypair.pubkey())

    await mm._run_once()

    assert len(_mm_orders(client, a, owner)) == 2
    assert _mm_orders(client, b, owner) == []
    assert f"Book unreadable for AAPL {b.market}, not quoting" in caplog.text


@pytest.mark.asyncio
async def test_order_cap_counts_leftovers_seen_on_the_fresh_read(
    mm_config: MMConfig, caplog: pytest.LogCaptureFixture
) -> None:
    """AB-10: 7 uncancellable leftovers + 2 new would exceed 8 -> not quoted."""
    clock = SimClock()
    a = _market(22000)
    client = FailingCancelClient(a.market)
    mm = _loop(mm_config, [a], client, clock)
    owner = str(mm.keypair.pubkey())
    for _ in range(7):
        await client.place_order(a.market, "Bid", 40, 10, owner)

    await mm._run_once()

    assert len(_mm_orders(client, a, owner)) == 7
    assert "would exceed max_orders_per_owner" in caplog.text
    assert mm.book_coverage == 0.0


@pytest.mark.asyncio
async def test_mint_failure_skips_only_that_market(
    mm_config: MMConfig, caplog: pytest.LogCaptureFixture
) -> None:
    class MintFails(FakeOrderClient):
        async def mint_pair(self, market: str, qty: int, owner: str) -> None:
            if market == a.market:
                raise RuntimeError("mint tx failed")
            await super().mint_pair(market, qty, owner)

    clock = SimClock()
    a, b = _market(22000), _market(23000)
    client = MintFails()
    mm = _loop(mm_config, [a, b], client, clock)
    owner = str(mm.keypair.pubkey())

    await mm._run_once()

    assert _mm_orders(client, a, owner) == []
    assert len(_mm_orders(client, b, owner)) == 2
    assert f"Failed to mint pairs for {a.market}" in caplog.text


@pytest.mark.asyncio
async def test_short_yes_at_inventory_cap_is_not_minted_or_quoted(mm_config: MMConfig) -> None:
    clock = SimClock()
    a = _market(22000)
    client = FakeOrderClient()
    mm = _loop(mm_config, [a], client, clock)
    owner = str(mm.keypair.pubkey())
    client.set_yes_balance(a.market, owner, 0)
    client.set_no_balance(a.market, owner, 200)  # position -200, YES short

    await mm._run_once()

    assert client.call_log == [("settle", a.market)]


@pytest.mark.asyncio
async def test_settle_failure_is_logged_and_the_market_still_requoted(
    mm_config: MMConfig, caplog: pytest.LogCaptureFixture
) -> None:
    class SettleFails(FakeOrderClient):
        async def settle_funds(self, market: str, owner: str) -> None:
            raise ConnectionError("settle tx failed")

    clock = SimClock()
    a = _market(22000)
    client = SettleFails()
    mm = _loop(mm_config, [a], client, clock)

    await mm._run_once()

    assert len(_mm_orders(client, a, str(mm.keypair.pubkey()))) == 2
    assert f"Failed to settle funds for {a.market}" in caplog.text
