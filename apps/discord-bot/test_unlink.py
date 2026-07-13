"""`/unlink` sends an UnlinkNotice with reason 'user_command' (→ backend hard-revoke). Uses a fake WS
so no real Discord/WS connection is needed (mirrors test_deliver.py)."""

import pytest

from zantiflow_notify import UnlinkNotice

import bot as m


class FakeWS:
    def __init__(self) -> None:
        self.sent: list = []

    async def send(self, msg: object) -> None:
        self.sent.append(msg)


@pytest.mark.asyncio
async def test_unlink_sends_user_command_notice():
    tb = m.DiscordBot("dummy-token", "ws://x/y", "s")
    tb.ws = FakeWS()

    await tb._unlink(42)

    assert len(tb.ws.sent) == 1
    notice = tb.ws.sent[0]
    assert isinstance(notice, UnlinkNotice)
    assert notice.platform == "discord"
    assert notice.platformUserId == "42"
    assert notice.reason == "user_command"
