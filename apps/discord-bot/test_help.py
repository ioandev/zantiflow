"""The Discord bot has help too: text mentions the website (default zantiflow.com) and the commands."""

import bot as m


def test_help_text_mentions_website_and_commands():
    text = m._help_text("https://example.test")
    assert "https://example.test" in text
    for cmd in ("/help", "/link", "/unlink"):
        assert cmd in text


def test_default_website_is_zantiflow_com():
    assert m.DEFAULT_WEBSITE == "https://zantiflow.com"
    assert "https://zantiflow.com" in m._help_text(m.DEFAULT_WEBSITE)


def test_bot_help_uses_configured_website():
    db = m.DiscordBot("dummy-token", "ws://x/y", "s", "https://my.site")
    assert "https://my.site" in db.help
