"""The Telegram bot's delivery handling is the shared, connection-free handler (the live aiogram
polling is wired at runtime). This asserts the deliver→ack contract without a real Telegram bot."""

import pytest

from zantiflow_notify import Deliver, DeliveryResult, handle_deliver


@pytest.mark.asyncio
async def test_deliver_failure_is_reported():
    acks: list = []

    async def dm(_user_id, _text):
        return False  # user blocked the bot

    async def send(msg):
        acks.append(msg)

    await handle_deliver(Deliver(deliveryId="d9", platformUserId="7", text="A session detached"), dm, send)
    assert isinstance(acks[0], DeliveryResult)
    assert acks[0].status == "failed"
