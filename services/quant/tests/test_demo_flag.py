"""MERIDIAN_DEMO_ALLOW_STALE_SPOT: off by default, devnet only, never mainnet."""

from meridian_quant.demo import demo_allow_stale_spot

DEVNET = {"SOLANA_CLUSTER": "devnet", "SOLANA_RPC_URL": "https://api.devnet.solana.com"}


def test_off_by_default() -> None:
    assert demo_allow_stale_spot({}) is False
    assert demo_allow_stale_spot(DEVNET) is False


def test_on_only_when_set_on_devnet() -> None:
    assert demo_allow_stale_spot({**DEVNET, "MERIDIAN_DEMO_ALLOW_STALE_SPOT": "1"}) is True
    assert demo_allow_stale_spot({**DEVNET, "MERIDIAN_DEMO_ALLOW_STALE_SPOT": "true"}) is False


def test_never_on_mainnet_or_other_clusters() -> None:
    flag = {"MERIDIAN_DEMO_ALLOW_STALE_SPOT": "1"}
    assert not demo_allow_stale_spot(
        {
            **flag,
            "SOLANA_CLUSTER": "mainnet-beta",
            "SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com",
        }
    )
    assert not demo_allow_stale_spot(
        {
            **flag,
            "SOLANA_CLUSTER": "devnet",
            "SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com",
        }
    )
    assert not demo_allow_stale_spot(
        {**flag, "SOLANA_CLUSTER": "localnet", "SOLANA_RPC_URL": "http://127.0.0.1:8899"}
    )
    assert not demo_allow_stale_spot({**flag, "SOLANA_CLUSTER": "devnet"})
