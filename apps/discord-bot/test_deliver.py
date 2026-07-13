"""The bot's message handling is exercised via the shared, connection-free handler. The live
discord.py client is only wired at runtime (compose); here we assert the deliver→ack contract."""

import pytest

from zantiflow_notify import Deliver, DeliveryResult, handle_deliver


@pytest.mark.asyncio
async def test_deliver_acks_after_dm():
    acks: list = []

    async def dm(user_id, text):
        assert user_id == "42"
        assert text == "Claude needs your input"
        return True

    async def send(msg):
        acks.append(msg)

    await handle_deliver(Deliver(deliveryId="d1", platformUserId="42", text="Claude needs your input"), dm, send)
    assert isinstance(acks[0], DeliveryResult)
    assert acks[0].status == "delivered"
