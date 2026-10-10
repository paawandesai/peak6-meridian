"""Blockhash handling on send: confirmed commitment, one refresh-and-retry on BlockhashNotFound.

Devnet 2026-10-10 (Helius, load-balanced): preflight sometimes landed on a node that had not
seen the cached blockhash yet and failed with "Blockhash not found".
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from solana.rpc.commitment import Confirmed
from solana.rpc.core import RPCException
from solders.hash import Hash
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction_status import TransactionConfirmationStatus

from meridian_quant.mm.chain import ChainOrderClient, Timing

BLOCKHASH_NOT_FOUND = (
    'SendTransactionPreflightFailureMessage { message: "Transaction simulation failed: '
    'Blockhash not found", data: RpcSimulateTransactionResult { err: Some(BlockhashNotFound) } }'
)


async def _no_sleep(_secs: float) -> None:
    return None


def _client(send_effects: list[object]) -> tuple[ChainOrderClient, AsyncMock]:
    rpc = AsyncMock()
    hashes = iter([Hash.new_unique() for _ in range(5)])

    async def latest_blockhash(*_a: object, **_k: object) -> MagicMock:
        resp = MagicMock()
        resp.value.blockhash = next(hashes)
        return resp

    rpc.get_latest_blockhash.side_effect = latest_blockhash
    ok = MagicMock()
    ok.value = Signature.default()
    rpc.send_transaction.side_effect = [ok if e is None else e for e in send_effects]
    status = MagicMock()
    status.err = None
    status.confirmation_status = TransactionConfirmationStatus.Finalized
    statuses = MagicMock()
    statuses.value = [status]
    rpc.get_signature_statuses.return_value = statuses
    client = ChainOrderClient(
        rpc, Pubkey.new_unique(), Keypair(), Pubkey.new_unique(), Timing(sleep=_no_sleep)
    )
    return client, rpc


def _ix() -> Instruction:
    return Instruction(Pubkey.new_unique(), b"\x01", [])


@pytest.mark.asyncio
async def test_blockhash_and_preflight_use_confirmed() -> None:
    client, rpc = _client([None])
    await client._send_and_confirm([_ix()])
    assert rpc.get_latest_blockhash.await_args.args == (Confirmed,)
    assert rpc.send_transaction.await_args.kwargs["opts"].preflight_commitment == Confirmed


@pytest.mark.asyncio
async def test_blockhash_not_found_refreshes_and_retries_once() -> None:
    client, rpc = _client([RPCException(BLOCKHASH_NOT_FOUND), None])
    sig = await client._send_and_confirm([_ix()])
    assert sig == Signature.default()
    assert rpc.send_transaction.await_count == 2
    assert rpc.get_latest_blockhash.await_count == 2
    first, second = (c.args[0] for c in rpc.send_transaction.await_args_list)
    assert first.message.recent_blockhash != second.message.recent_blockhash


@pytest.mark.asyncio
async def test_blockhash_not_found_twice_raises() -> None:
    client, rpc = _client([RPCException(BLOCKHASH_NOT_FOUND), RPCException(BLOCKHASH_NOT_FOUND)])
    with pytest.raises(RPCException):
        await client._send_and_confirm([_ix()])
    assert rpc.send_transaction.await_count == 2


@pytest.mark.asyncio
async def test_other_preflight_errors_are_not_retried() -> None:
    err = RPCException("Transaction simulation failed: custom program error: 0x177f")
    client, rpc = _client([err])
    with pytest.raises(RPCException):
        await client._send_and_confirm([_ix()])
    assert rpc.send_transaction.await_count == 1
