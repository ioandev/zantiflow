"""Real Discord slash commands (not message-text parsing) are registered and route to the backend.

This is the fix for "slash commands don't work in DMs": the bot registers /link, /unlink and /help on
its command tree (mirroring the meditation-bot reference) instead of scanning message content, which
Discord's client intercepts (the `/` opens the native picker) before the text ever reaches the bot.
Invoking a tree command runs it as an interaction, which works in DMs.
"""

import pytest

from zantiflow_notify import LinkRequest, LinkResult, UnlinkNotice

import bot as m


class FakeWS:
    def __init__(self) -> None:
        self.sent: list = []

    async def send(self, msg: object) -> None:
        self.sent.append(msg)


class FakeUser:
    def __init__(self, uid: int, name: str) -> None:
        self.id = uid
        self._name = name

    def __str__(self) -> str:
        return self._name


class FakeResponse:
    def __init__(self) -> None:
        self.messages: list = []
        self.ephemeral: list = []
        self.deferred = False
        self.deferred_ephemeral = None

    async def send_message(self, content=None, **kwargs) -> None:
        self.messages.append(content)
        self.ephemeral.append(kwargs.get("ephemeral", False))

    async def defer(self, **kwargs) -> None:
        self.deferred = True
        self.deferred_ephemeral = kwargs.get("ephemeral", False)


class FakeInteraction:
    def __init__(self, user: FakeUser) -> None:
        self.user = user
        self.response = FakeResponse()
        self.edited: list = []

    async def edit_original_response(self, content=None, **kwargs) -> None:
        self.edited.append(content)


def _bot() -> m.DiscordBot:
    db = m.DiscordBot("dummy-token", "ws://x/y", "s")
    db.ws = FakeWS()  # _link/_unlink read self.ws at call time, so this override is honored
    return db


def test_link_unlink_help_are_real_tree_commands():
    db = _bot()
    names = {c.name for c in db.client.tree.get_commands()}
    assert {"help", "link", "unlink"} <= names


@pytest.mark.asyncio
async def test_link_slash_sends_link_request_and_defers_without_interstitial():
    db = _bot()
    inter = FakeInteraction(FakeUser(42, "alice#0"))
    await db.client.tree.get_command("link").callback(inter, "my-token")

    assert len(db.ws.sent) == 1
    req = db.ws.sent[0]
    assert isinstance(req, LinkRequest)
    assert req.platform == "discord"
    assert req.platformUserId == "42"
    assert req.platformUsername == "alice#0"
    assert req.token == "my-token"
    # No interstitial "Linking…" message — just an ephemeral defer, and the interaction is tracked
    # so the eventual LinkResult resolves it in place.
    assert inter.response.messages == []
    assert inter.response.deferred is True
    assert inter.response.deferred_ephemeral is True
    assert db._pending_links["42"] is inter


@pytest.mark.asyncio
async def test_link_result_resolves_pending_interaction_in_place():
    db = _bot()
    inter = FakeInteraction(FakeUser(42, "alice#0"))
    db._pending_links["42"] = inter

    dm_calls: list = []

    async def fake_dm(user_id, text):
        dm_calls.append((user_id, text))
        return True

    db.dm = fake_dm

    await db.on_backend(LinkResult(token="t", ok=True, platformUserId="42"))

    # Confirmation edits the deferred response instead of DMing, and the pending entry is cleared.
    assert inter.edited and "Linked" in inter.edited[0]
    assert dm_calls == []
    assert "42" not in db._pending_links


@pytest.mark.asyncio
async def test_unlink_slash_sends_user_command_notice():
    db = _bot()
    inter = FakeInteraction(FakeUser(42, "alice#0"))
    await db.client.tree.get_command("unlink").callback(inter)

    assert len(db.ws.sent) == 1
    notice = db.ws.sent[0]
    assert isinstance(notice, UnlinkNotice)
    assert notice.platform == "discord"
    assert notice.platformUserId == "42"
    assert notice.reason == "user_command"


@pytest.mark.asyncio
async def test_help_slash_shows_help_text():
    db = _bot()
    inter = FakeInteraction(FakeUser(1, "bob#0"))
    await db.client.tree.get_command("help").callback(inter)
    assert inter.response.messages[0] == db.help
