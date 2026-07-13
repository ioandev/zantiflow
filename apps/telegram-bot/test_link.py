"""On a LinkResult, the bot DMs the user the confirmation it promised (routed by platformUserId).

Also covers `_link`'s platformUsername: Telegram @usernames are optional, so when a user has none the
bot must fall back to the display name — otherwise the linked account shows blank in the dashboard.
"""

import pytest

from zantiflow_notify import LinkRequest, LinkResult

import bot as m


class FakeWS:
    def __init__(self) -> None:
        self.sent: list = []

    async def send(self, msg: object) -> None:
        self.sent.append(msg)


class FakeUser:
    def __init__(self, uid: int, username, first_name: str, last_name=None) -> None:
        self.id = uid
        self.username = username
        self.first_name = first_name
        self.last_name = last_name

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}" if self.last_name else self.first_name


class FakeMessage:
    def __init__(self, user: FakeUser) -> None:
        self.from_user = user
        self.answers: list = []

    async def answer(self, text: str) -> None:
        self.answers.append(text)


def _bot_with_capture():
    tb = m.TelegramBot("123456:dummy", "ws://x/y", "s")
    sent: list = []

    async def fake_dm(user_id, text):
        sent.append((user_id, text))
        return True

    tb.dm = fake_dm
    return tb, sent


@pytest.mark.asyncio
async def test_link_uses_username_when_present():
    tb, _ = _bot_with_capture()
    tb.ws = FakeWS()
    await tb._link(FakeMessage(FakeUser(7, "ioanb", "Ioan", "Biticu")), "tok")
    req = tb.ws.sent[0]
    assert isinstance(req, LinkRequest)
    assert req.platformUsername == "ioanb"


@pytest.mark.asyncio
async def test_link_falls_back_to_full_name_when_no_username():
    tb, _ = _bot_with_capture()
    tb.ws = FakeWS()
    # No @username set (the common Telegram case) → must not be blank.
    await tb._link(FakeMessage(FakeUser(7, None, "Ioan", "Biticu")), "tok")
    req = tb.ws.sent[0]
    assert req.platformUsername == "Ioan Biticu"


@pytest.mark.asyncio
async def test_link_result_ok_dms_confirmation():
    tb, sent = _bot_with_capture()
    await tb.on_backend(LinkResult(token="t", ok=True, platformUserId="7"))
    assert len(sent) == 1
    assert sent[0][0] == "7"
    assert "Linked" in sent[0][1]


@pytest.mark.asyncio
async def test_link_result_failure_dms_reason():
    tb, sent = _bot_with_capture()
    await tb.on_backend(LinkResult(token="t", ok=False, platformUserId="7", error="invalid_or_expired_token"))
    assert len(sent) == 1
    assert "invalid_or_expired_token" in sent[0][1]


@pytest.mark.asyncio
async def test_link_result_without_user_id_is_noop():
    tb, sent = _bot_with_capture()
    await tb.on_backend(LinkResult(token="t", ok=True))  # older backend: no platformUserId
    assert sent == []
