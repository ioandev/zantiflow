"""zantiflow Telegram notification bot (ADR-0007/0010).

Holds an OUTBOUND WS to the backend. Users link by opening the bot with a deep link
(`https://t.me/<bot>?start=<token>`) or sending `/link <token>`; the backend then dispatches `deliver`
messages which this bot sends as DMs, acking each with `delivery_result`.
"""

from __future__ import annotations

import asyncio
import logging
import os

from aiogram import Bot, Dispatcher
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import Message
from dotenv import load_dotenv

from zantiflow_notify import BotClient, Deliver, LinkRequest, LinkResult, UnlinkNotice, handle_deliver

log = logging.getLogger("zantiflow.telegram")

# The public zantiflow site shown in help/onboarding. Self-hosters override via WEBSITE_URL.
DEFAULT_WEBSITE = "https://zantiflow.com"


def _help_text(website: str) -> str:
    return (
        "👋 This is the zantiflow notifications bot.\n\n"
        "It DMs you when one of your terminal sessions needs attention — e.g. Claude is waiting on you, "
        "or a session stopped.\n\n"
        f"Learn more about zantiflow and manage your account at {website}\n\n"
        "To connect your account:\n"
        f"• open your dashboard at {website} → Integrations → Telegram, then\n"
        "• open the Telegram link it shows (or send /link <token> with the token it gives you).\n\n"
        "Commands:\n"
        "/start – show this message\n"
        "/help – show this message\n"
        "/link <token> – link your account\n"
        "/unlink – stop notifications to this chat"
    )


class TelegramBot:
    def __init__(self, token: str, ws_url: str, service_secret: str, website: str = DEFAULT_WEBSITE) -> None:
        self.bot = Bot(token)
        self.dp = Dispatcher()
        self.ws = BotClient(ws_url, "telegram", service_secret, self.on_backend)
        self.website = website
        self.help = _help_text(website)
        self._wire()

    def _wire(self) -> None:
        # `/start <token>` (the website deep link) links the account; a bare `/start` and `/help`
        # both show the welcome/help. The deep-link handler is registered first so it wins for
        # payload starts; the bare handler catches the rest.
        @self.dp.message(CommandStart(deep_link=True))
        async def on_start(message: Message, command: CommandObject) -> None:  # noqa: ANN202
            if command.args:
                await self._link(message, command.args.strip())

        @self.dp.message(CommandStart())
        async def on_start_bare(message: Message) -> None:  # noqa: ANN202
            await message.answer(self.help)

        @self.dp.message(Command("help"))
        async def on_help(message: Message) -> None:  # noqa: ANN202
            await message.answer(self.help)

        @self.dp.message(Command("link"))
        async def on_link(message: Message, command: CommandObject) -> None:  # noqa: ANN202
            if command.args:
                await self._link(message, command.args.strip())
            else:
                await message.answer(
                    f"Usage: /link <token> — get a token at {self.website} → Integrations → Telegram."
                )

        @self.dp.message(Command("unlink"))
        async def on_unlink(message: Message) -> None:  # noqa: ANN202
            await self._unlink(message)

    async def _link(self, message: Message, token: str) -> None:
        user = message.from_user
        # Telegram @usernames are OPTIONAL, so user.username is often None — which would show the
        # linked account as blank in the dashboard. Fall back to the display name (full_name is always
        # present: first_name is required by Telegram), so the account is always identifiable.
        await self.ws.send(
            LinkRequest(
                platform="telegram",
                platformUserId=str(user.id),
                platformUsername=user.username or user.full_name,
                token=token,
            )
        )
        await message.answer("Linking your account… you'll get a confirmation shortly.")

    async def _unlink(self, message: Message) -> None:
        # A deliberate, user-typed unlink → reason 'user_command' so the backend hard-unlinks
        # (status 'revoked'), same as the website's disconnect (ADR-0007).
        user = message.from_user
        await self.ws.send(UnlinkNotice(platform="telegram", platformUserId=str(user.id), reason="user_command"))
        await message.answer(
            "Unlinked — you won't receive zantiflow notifications here anymore. Re-link anytime with /link <token>."
        )

    async def dm(self, user_id: str, text: str) -> bool:
        try:
            await self.bot.send_message(int(user_id), text)
            return True
        except Exception:  # noqa: BLE001 — a blocked user is a delivery failure, not a crash
            log.warning("failed to DM %s", user_id)
            return False

    async def on_backend(self, msg: object) -> None:
        if isinstance(msg, Deliver):
            await handle_deliver(msg, self.dm, self.ws.send)
        elif isinstance(msg, LinkResult):
            log.info("link_result ok=%s error=%s", msg.ok, msg.error)
            # Deliver the confirmation we promised in _link(). The result echoes platformUserId so we
            # know which chat to reply to (an older backend may omit it → we just skip the DM).
            if msg.platformUserId:
                if msg.ok:
                    text = "✅ Linked! You'll get zantiflow notifications here. Send /unlink to stop."
                else:
                    reason = msg.error or "invalid or expired token"
                    text = f"❌ Couldn't link: {reason}. Get a fresh token at {self.website} → Integrations → Telegram."
                await self.dm(msg.platformUserId, text)

    async def run(self) -> None:
        # Supervised: if the backend WS loop ever dies unexpectedly, the bot terminates (and the
        # supervisor restarts it) rather than polling Telegram forever with a dead backend link.
        self.ws.start()
        await self.dp.start_polling(self.bot)


def main() -> None:
    load_dotenv()  # load apps/telegram-bot/.env in dev; compose env_file / real env still win.
    logging.basicConfig(level=logging.INFO)
    # Build identity — baked into the image at build time (see Dockerfile / docker-publish.yml).
    log.info(
        "zantiflow telegram-bot starting version=%s commit=%s",
        os.environ.get("APP_VERSION", "dev"),
        os.environ.get("GIT_SHA", "unknown"),
    )
    bot = TelegramBot(
        os.environ["TELEGRAM_BOT_TOKEN"],
        os.environ.get("BACKEND_WS_URL", "ws://backend:4000/internal/bots"),
        os.environ["BOT_SERVICE_SECRET"],
        os.environ.get("WEBSITE_URL", DEFAULT_WEBSITE),
    )
    asyncio.run(bot.run())


if __name__ == "__main__":
    main()
