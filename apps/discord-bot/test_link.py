"""On a LinkResult, the bot DMs the user the confirmation it promised (routed by platformUserId)."""

import pytest

from zantiflow_notify import LinkResult

import bot as m


def _bot_with_capture():
    db = m.DiscordBot("dummy-token", "ws://x/y", "s")
    sent: list = []

    async def fake_dm(user_id, text):
        sent.append((user_id, text))
        return True

    db.dm = fake_dm
    return db, sent


@pytest.mark.asyncio
async def test_link_result_ok_dms_confirmation():
    db, sent = _bot_with_capture()
    await db.on_backend(LinkResult(token="t", ok=True, platformUserId="42"))
    assert len(sent) == 1
    assert sent[0][0] == "42"
    assert "Linked" in sent[0][1]


@pytest.mark.asyncio
async def test_link_result_failure_dms_reason():
    db, sent = _bot_with_capture()
    await db.on_backend(LinkResult(token="t", ok=False, platformUserId="42", error="invalid_or_expired_token"))
    assert len(sent) == 1
    assert "invalid_or_expired_token" in sent[0][1]


@pytest.mark.asyncio
async def test_link_result_without_user_id_is_noop():
    db, sent = _bot_with_capture()
    await db.on_backend(LinkResult(token="t", ok=True))  # older backend: no platformUserId
    assert sent == []
