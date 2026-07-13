"""zantiflow Discord notification bot (ADR-0007/0010).

Holds an OUTBOUND WS to the backend (`/internal/bots`). Users run the `/link <token>` slash command
(token minted on the website) to bind their Discord account; the backend then dispatches `deliver`
messages which this bot sends as DMs, acking each with `delivery_result`. No public ingress.

Commands are REAL Discord application (slash) commands — registered on the bot's command tree and
`tree.sync()`'d on ready, mirroring the meditation-bot reference. The previous version only scanned
message *content* for a literal "/link", which does not work in DMs: Discord's client owns the `/`
key (it opens the native command picker), so the raw text never reaches the bot. Real slash commands
are dispatched as interactions instead, so they work in DMs. `on_message` remains as a fallback that
handles a pasted command and greets any other DM with help.
"""

from __future__ import annotations

import logging
import os

import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv

from zantiflow_notify import BotClient, Deliver, LinkRequest, LinkResult, UnlinkNotice, handle_deliver

log = logging.getLogger("zantiflow.discord")
LINK_PREFIX = "/link "
UNLINK_CMD = "/unlink"

# The public zantiflow site shown in help/onboarding. Self-hosters override via WEBSITE_URL.
DEFAULT_WEBSITE = "https://zantiflow.com"


def _help_text(website: str) -> str:
    return (
        "👋 This is the zantiflow notifications bot.\n\n"
        "It DMs you when one of your terminal sessions needs attention — e.g. Claude is waiting on you, "
        "or a session stopped.\n\n"
        f"Learn more about zantiflow and manage your account at {website}\n\n"
        "To connect your account:\n"
        f"• open your dashboard at {website} → Integrations → Discord, then\n"
        "• run the `/link` slash command here and paste the token it shows you.\n\n"
        "Commands (type `/` to pick one):\n"
        "/help – show this message\n"
        "/link <token> – link your account\n"
        "/unlink – stop notifications to this chat"
    )


class DiscordBot:
    def __init__(self, discord_token: str, ws_url: str, service_secret: str, website: str = DEFAULT_WEBSITE) -> None:
        self.discord_token = discord_token
        self.website = website
        self.help = _help_text(website)
        # Pending /link slash interactions, keyed by platformUserId, awaiting the backend's LinkResult
        # so it can resolve the deferred response in place instead of sending an interstitial message.
        self._pending_links: dict[str, discord.Interaction] = {}
        intents = discord.Intents.default()
        intents.message_content = True  # for the plain-text DM fallback/onboarding in on_message
        intents.members = True  # to greet new members on join (on_member_join) — a privileged intent
        # A commands.Bot (not a bare Client) so we get a `.tree` for real slash commands. We never use
        # prefix commands, so the prefix is a placeholder that would require an @mention.
        self.client = commands.Bot(command_prefix=commands.when_mentioned, intents=intents)
        self.ws = BotClient(ws_url, "discord", service_secret, self.on_backend)
        self._wire()

    def _wire(self) -> None:
        bot = self.client

        @bot.event
        async def on_ready() -> None:  # noqa: ANN202
            log.info("discord ready as %s", bot.user)
            # Register the slash commands with Discord. Global sync can take a moment to propagate to
            # DMs; a failure here must not take the bot down, so log and carry on.
            try:
                synced = await bot.tree.sync()
                log.info("synced %d slash command(s): %s", len(synced), [c.name for c in synced])
            except Exception:  # noqa: BLE001
                log.exception("failed to sync slash commands")
            # Supervised: if the backend WS loop ever dies unexpectedly, the bot terminates (and the
            # supervisor restarts it) rather than serving Discord forever with a dead backend link.
            self.ws.start()

        @bot.tree.command(name="help", description="What this bot is and how to connect your account.")
        async def help_cmd(interaction: discord.Interaction) -> None:  # noqa: ANN202
            await interaction.response.send_message(self.help, ephemeral=True)

        @bot.tree.command(name="link", description="Link your zantiflow account with a token from the dashboard.")
        @app_commands.describe(token="The link token shown at your dashboard → Integrations → Discord")
        async def link_cmd(interaction: discord.Interaction, token: str) -> None:  # noqa: ANN202
            # The confirmation is async (it comes back from the backend as a LinkResult), so ack the
            # interaction now with an ephemeral defer — no interstitial text — and remember it so the
            # LinkResult fills this same response in place. Ephemeral keeps a mistyped token private.
            await interaction.response.defer(ephemeral=True, thinking=True)
            self._pending_links[str(interaction.user.id)] = interaction
            await self._link(interaction.user, token)

        @bot.tree.command(name="unlink", description="Stop zantiflow notifications to this chat.")
        async def unlink_cmd(interaction: discord.Interaction) -> None:  # noqa: ANN202
            await self._unlink(interaction.user.id)
            await interaction.response.send_message(
                "Unlinked — you won't receive zantiflow notifications here anymore. Re-link with /link.",
                ephemeral=True,
            )

        @bot.event
        async def on_member_join(member: discord.Member) -> None:  # noqa: ANN202
            await self._welcome(member)

        @bot.event
        async def on_message(message: discord.Message) -> None:  # noqa: ANN202
            # Slash commands arrive as interactions, not messages — so this is only a fallback: a user
            # who pastes "/link <token>" as literal text still gets linked, and any other DM (Discord
            # has no /start to greet on) is answered with the help/onboarding text.
            if message.author.bot or not isinstance(message.channel, discord.DMChannel):
                return
            content = message.content.strip()
            if content.startswith(LINK_PREFIX):
                # No interstitial ack — the backend's LinkResult confirmation arrives as a DM shortly.
                await self._link(message.author, content[len(LINK_PREFIX):].strip())
            elif content == UNLINK_CMD:
                await self._unlink(message.author.id)
                await message.channel.send(
                    "Unlinked — you won't receive zantiflow notifications here anymore. Re-link with /link <token>."
                )
            else:
                await message.channel.send(self.help)

    async def _link(self, user: discord.abc.User, token: str) -> None:
        await self.ws.send(
            LinkRequest(
                platform="discord",
                platformUserId=str(user.id),
                platformUsername=str(user),
                token=token,
            )
        )

    async def _unlink(self, author_id: int) -> None:
        # A deliberate, user-typed unlink → reason 'user_command' so the backend hard-unlinks
        # (status 'revoked'), same as the website's disconnect (ADR-0007).
        await self.ws.send(UnlinkNotice(platform="discord", platformUserId=str(author_id), reason="user_command"))

    async def _welcome(self, member: discord.Member) -> None:
        # When someone joins a server the bot is in, DM them the help/onboarding text so they know
        # what the bot is and how to /link. Skip bots; a closed-DMs member just can't be greeted.
        if member.bot:
            return
        try:
            await member.send(self.help)
        except Exception:  # noqa: BLE001 — DMs disabled/blocked is expected, not a crash
            log.info("could not send welcome DM to %s (DMs closed?)", member.id)

    async def dm(self, user_id: str, text: str) -> bool:
        try:
            user = await self.client.fetch_user(int(user_id))
            await user.send(text)
            return True
        except Exception:  # noqa: BLE001 — a blocked/left user is a delivery failure, not a crash
            log.warning("failed to DM %s", user_id)
            return False

    async def on_backend(self, msg: object) -> None:
        if isinstance(msg, Deliver):
            await handle_deliver(msg, self.dm, self.ws.send)
        elif isinstance(msg, LinkResult):
            log.info("link_result ok=%s error=%s", msg.ok, msg.error)
            # The result echoes platformUserId so we know who it's for (an older backend may omit it →
            # nothing to deliver).
            if msg.platformUserId:
                if msg.ok:
                    text = "✅ Linked! You'll get zantiflow notifications here. Send /unlink to stop."
                else:
                    reason = msg.error or "invalid or expired token"
                    text = f"❌ Couldn't link: {reason}. Get a fresh token at {self.website} → Integrations → Discord."
                # Prefer resolving the pending /link slash interaction in place (fills its deferred
                # "thinking" state); otherwise (a text-typed /link, or an expired interaction) DM it.
                interaction = self._pending_links.pop(msg.platformUserId, None)
                if interaction is not None:
                    try:
                        await interaction.edit_original_response(content=text)
                        return
                    except Exception:  # noqa: BLE001 — interaction expired/unavailable → fall back to DM
                        log.info("link interaction unavailable for %s; DMing instead", msg.platformUserId)
                await self.dm(msg.platformUserId, text)

    def run(self) -> None:
        self.client.run(self.discord_token)


def main() -> None:
    load_dotenv()  # load apps/discord-bot/.env in dev; compose env_file / real env still win.
    logging.basicConfig(level=logging.INFO)
    # Build identity — baked into the image at build time (see Dockerfile / docker-publish.yml).
    log.info(
        "zantiflow discord-bot starting version=%s commit=%s",
        os.environ.get("APP_VERSION", "dev"),
        os.environ.get("GIT_SHA", "unknown"),
    )
    DiscordBot(
        os.environ["DISCORD_BOT_TOKEN"],
        os.environ.get("BACKEND_WS_URL", "ws://backend:4000/internal/bots"),
        os.environ["BOT_SERVICE_SECRET"],
        os.environ.get("WEBSITE_URL", DEFAULT_WEBSITE),
    ).run()


if __name__ == "__main__":
    main()
