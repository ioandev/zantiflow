import pytest

from zantiflow_notify import Deliver, DeliveryResult, handle_deliver


@pytest.mark.asyncio
async def test_handle_deliver_dms_then_acks_delivered():
    sent: list = []

    async def dm(_user, _text):
        return True

    async def send(msg):
        sent.append(msg)

    ok = await handle_deliver(Deliver(deliveryId="d1", platformUserId="u1", text="hi"), dm, send)
    assert ok is True
    assert isinstance(sent[0], DeliveryResult)
    assert sent[0].deliveryId == "d1"
    assert sent[0].status == "delivered"


@pytest.mark.asyncio
async def test_handle_deliver_reports_failure_when_dm_fails():
    sent: list = []

    async def dm(_user, _text):
        return False

    async def send(msg):
        sent.append(msg)

    ok = await handle_deliver(Deliver(deliveryId="d2", platformUserId="u2", text="hi"), dm, send)
    assert ok is False
    assert sent[0].status == "failed"
    assert sent[0].error == "dm_failed"
