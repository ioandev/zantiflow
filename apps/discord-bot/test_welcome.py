"""When a new member joins a server the bot is in, it DMs them the help/onboarding text.

Driven through `_welcome` (what the on_member_join event calls) with a fake member, so no gateway is
needed. Requires the Server Members privileged intent at runtime.
"""

import pytest

import bot as m


class FakeMember:
    def __init__(self, uid: int, is_bot: bool = False) -> None:
        self.id = uid
        self.bot = is_bot
        self.sent: list = []

    async def send(self, text: str) -> None:
        self.sent.append(text)


def _bot() -> m.DiscordBot:
    return m.DiscordBot("dummy-token", "ws://x/y", "s")


@pytest.mark.asyncio
async def test_welcome_dms_help_to_new_human_member():
    db = _bot()
    member = FakeMember(7)
    await db._welcome(member)
    assert member.sent == [db.help]


@pytest.mark.asyncio
async def test_welcome_skips_other_bots():
    db = _bot()
    member = FakeMember(7, is_bot=True)
    await db._welcome(member)
    assert member.sent == []


@pytest.mark.asyncio
async def test_welcome_survives_closed_dms():
    db = _bot()

    class Blocked(FakeMember):
        async def send(self, text: str) -> None:
            raise RuntimeError("Cannot send messages to this user")

    member = Blocked(9)
    await db._welcome(member)  # must not raise
    assert member.sent == []
