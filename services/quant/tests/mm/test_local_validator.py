"""Local validator test for MM loop (M3-02 AC1).

With M3-01 fair values (fake allowed), every open strike gets a bid and an ask
within one _run_once on a local validator.

IMPORTANT: Run under flock /tmp/box-heavy.lock per operator-rules §9.
"""

import asyncio
import json
import os
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from spl.token.async_client import AsyncToken
from spl.token.constants import TOKEN_PROGRAM_ID

from meridian_quant.mm.chain import ChainMarketSource, ChainOrderClient
from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource
from meridian_quant.mm.loop import MarketMakerLoop
from meridian_quant.mm.types import FairValue


@pytest.mark.asyncio
@pytest.mark.skipif(
    not Path("target/deploy/meridian.so").exists() or not Path("scripts/e2e.sh").exists(),
    reason="Requires prebuilt target/deploy/meridian.so and scripts/e2e.sh",
)
async def test_mm_quotes_local_validator() -> None:  # noqa: PLR0912, PLR0915
    """AC1: One _run_once leaves two-sided MM quotes on every open strike.

    Uses PREBUILT target/deploy/meridian.so and existing e2e seed infrastructure
    (Config + test-USDC + markets). Verifies MM loop places bid AND ask on every
    open strike.

    Run with: flock /tmp/box-heavy.lock pytest -k test_mm_quotes_all_open_strikes
    """
    # Operator Tier 1 decision: implement now using existing e2e bootstrap
    validator_process = None

    try:
        # Start validator with prebuilt program (mirroring scripts/e2e.sh)
        program_id = "5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi"
        rpc_url = "http://localhost:8899"

        # Check no validator already running
        try:
            result = subprocess.run(
                ["solana", "cluster-version", "--url", rpc_url],
                capture_output=True,
                timeout=2,
                check=False,
            )
            if result.returncode == 0:
                pytest.skip(f"Validator already running on {rpc_url}")
        except subprocess.TimeoutExpired:
            pytest.skip(f"Validator not responding on {rpc_url}")

        # Start validator (trap "kill 0" EXIT pattern via Python subprocess management)
        print("Starting solana-test-validator...")
        validator_process = subprocess.Popen(
            [
                "solana-test-validator",
                "--reset",
                "--quiet",
                "--bpf-program",
                program_id,
                "target/deploy/meridian.so",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

        # Wait for validator to be ready
        for _ in range(60):
            try:
                result = subprocess.run(
                    ["solana", "cluster-version", "--url", rpc_url],
                    capture_output=True,
                    timeout=2,
                    check=False,
                )
                if result.returncode == 0:
                    break
            except subprocess.TimeoutExpired:
                pass

            if validator_process.poll() is not None:
                stderr_text = ""
                if validator_process.stderr:
                    stderr_text = validator_process.stderr.read().decode()
                pytest.fail(f"Validator exited during startup: {stderr_text}")

            await asyncio.sleep(1)

        print("Validator ready")

        # Create payer keypair
        payer_path = Path("target/test-payer.json")
        if not payer_path.exists():
            subprocess.run(
                ["solana-keygen", "new", "--no-bip39-passphrase", "-s", "-o", str(payer_path)],
                check=True,
                capture_output=True,
            )

        # Airdrop to payer
        subprocess.run(
            ["solana", "airdrop", "100", "--url", rpc_url, "--keypair", str(payer_path)],
            check=True,
            capture_output=True,
        )

        # Run e2e seed to create Config + markets (E2E_SEED_ONLY=1)
        print("Seeding Config and markets...")
        env = os.environ.copy()
        env.update(
            {
                "ANCHOR_PROVIDER_URL": rpc_url,
                "ANCHOR_WALLET": str(payer_path),
                "E2E_PROGRAM_ID": program_id,
                "E2E_SEED_ONLY": "1",
                "E2E_CLOSE_IN_SECS": "3600",
            }
        )

        seed_result = subprocess.run(
            ["pnpm", "--filter", "e2e", "run", "lifecycle"],
            cwd=str(Path.cwd()),
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )

        if seed_result.returncode != 0:
            pytest.fail(f"Seed failed:\nstdout: {seed_result.stdout}\nstderr: {seed_result.stderr}")

        # Extract USDC mint from seed output
        usdc_match = re.search(r"SEED_USDC_MINT=(\S+)", seed_result.stdout)
        if not usdc_match:
            pytest.fail(f"Seed did not report USDC mint:\n{seed_result.stdout}")

        usdc_mint_str = usdc_match.group(1)
        print(f"USDC mint: {usdc_mint_str}")

        # Now run MM loop with chain clients
        rpc_client = AsyncClient(rpc_url)
        program_pubkey = Pubkey.from_string(program_id)
        usdc_mint = Pubkey.from_string(usdc_mint_str)

        # Create MM keypair and airdrop SOL
        mm_keypair = Keypair()
        airdrop_sig = await rpc_client.request_airdrop(mm_keypair.pubkey(), 5_000_000_000)
        await rpc_client.confirm_transaction(airdrop_sig.value)

        # Create and fund USDC ATA for MM (required for mint_pair/place_order)
        usdc_token = AsyncToken(rpc_client, usdc_mint, TOKEN_PROGRAM_ID, mm_keypair)
        mm_usdc_ata = await usdc_token.create_associated_token_account(mm_keypair.pubkey())

        # Mint test USDC to MM (need this to mint pairs)
        # Load payer keypair to mint USDC
        payer_bytes = json.loads(payer_path.read_text())
        payer_keypair = Keypair.from_bytes(bytes(payer_bytes))
        usdc_as_payer = AsyncToken(rpc_client, usdc_mint, TOKEN_PROGRAM_ID, payer_keypair)
        await usdc_as_payer.mint_to(
            mm_usdc_ata,
            payer_keypair,
            100_000_000_000,  # 100k USDC (6 decimals)
        )

        # Create MM config
        keypair_json = json.dumps(list(bytes(mm_keypair)))
        config = MMConfig.model_validate(
            {
                "market_maker_keypair": keypair_json,
                "program_id": program_id,
                "usdc_mint": usdc_mint_str,
                "service_token": "test_token",
                "rpc_url": rpc_url,
            }
        )

        # Create on-chain clients
        market_source = ChainMarketSource(rpc_client, program_pubkey)
        order_client = ChainOrderClient(rpc_client, program_pubkey, mm_keypair, usdc_mint)

        # Fetch open markets
        open_markets = await market_source.fetch_open_markets()
        print(f"Found {len(open_markets)} open markets")
        assert len(open_markets) >= 2, f"Expected 2+ markets, got {len(open_markets)}"

        # Create fake fair values for all strikes
        now = datetime.now(UTC)
        fair_values = [
            FairValue(
                market=m.market,
                ticker=m.ticker,
                strike_cents=m.strike_cents,
                fair_cents=50,
                sigma=0.2,
                spot=230.0,
                as_of=now,
            )
            for m in open_markets
        ]
        fv_source = FakeFairValueSource(fair_values)

        # Create and run MM loop
        mm_loop = MarketMakerLoop(
            config=config,
            market_source=market_source,
            fair_value_source=fv_source,
            order_client=order_client,
        )

        # AC1: One _run_once must leave bid AND ask on every open strike
        print("Running MM loop once...")
        await mm_loop._run_once()

        # Verify quotes placed
        mm_owner = str(mm_loop.keypair.pubkey())
        for market in open_markets:
            orders = await order_client.fetch_resting_orders(market.market)
            mm_orders = [o for o in orders if o.owner == mm_owner]

            bids = [o for o in mm_orders if o.side == "Bid"]
            asks = [o for o in mm_orders if o.side == "Ask"]

            assert len(bids) == 1, (
                f"{market.ticker} ${market.strike_cents / 100:.0f}: expected 1 bid, got {len(bids)}"
            )
            assert len(asks) == 1, (
                f"{market.ticker} ${market.strike_cents / 100:.0f}: expected 1 ask, got {len(asks)}"
            )
            assert bids[0].price < asks[0].price, (
                f"{market.ticker}: bid {bids[0].price} >= ask {asks[0].price}"
            )

        print(f"✓ AC1 PASS: {len(open_markets)} markets, all have bid+ask from MM")

    finally:
        # Cleanup: kill validator (trap "kill 0" EXIT equivalent)
        if validator_process and validator_process.poll() is None:
            validator_process.terminate()
            try:
                validator_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                validator_process.kill()
                validator_process.wait()
