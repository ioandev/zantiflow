"""`/unlink` sends an UnlinkNotice with reason 'user_command' (→ backend hard-revoke). Uses a fake WS
and a duck-typed message so no real Telegram/WS connection is needed (mirrors test_deliver.py)."""

import pytest

from zantiflow_notify import UnlinkNotice

import bot as m


class FakeWS:
    def __init__(self) -> None:
        self.sent: list = []

    async def send(self, msg: object) -> None:
        self.sent.append(msg)


class FakeUser:
    id = 7


class FakeMessage:
    from_user = FakeUser()

    def __init__(self) -> None:
        self.answers: list = []

    async def answer(self, text: str) -> None:
        self.answers.append(text)


@pytest.mark.asyncio
async def test_unlink_sends_user_command_notice():
    tb = m.TelegramBot("123456:dummy", "ws://x/y", "s")
    tb.ws = FakeWS()
    msg = FakeMessage()

    await tb._unlink(msg)

    assert len(tb.ws.sent) == 1
    notice = tb.ws.sent[0]
    assert isinstance(notice, UnlinkNotice)
    assert notice.platform == "telegram"
    assert notice.platformUserId == "7"
    assert notice.reason == "user_command"
    assert msg.answers  # the user gets a confirmation
