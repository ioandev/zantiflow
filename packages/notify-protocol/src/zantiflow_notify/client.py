"""A reconnecting WebSocket client to the backend's internal bot endpoint (ADR-0007).

Bots dial OUT (no public ingress). On connect the client sends ``hello``; each inbound frame is parsed
and handed to ``on_message``. Disconnects trigger exponential backoff reconnects; the backoff is reset
only once a connection has proven *stable* (see ``STABLE_CONNECTION_SEC``), so a flapping backend can't
trap the client in a 1 Hz reconnect storm.

Liveness is kept by WebSocket keepalive (ping/pong): the client pings the backend every
``PING_INTERVAL`` seconds and, if no pong returns within ``PING_TIMEOUT``, the ``websockets`` library
closes the connection as dead — which drops into the reconnect loop below. The backend's ``ws`` server
auto-responds to pings, so no application-level protocol message is needed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import time
from typing import TYPE_CHECKING, Awaitable, Callable, Optional, Union

import websockets

from .models import PROTOCOL_VERSION, Deliver, HelloAck, LinkResult, Platform, parse_backend_message

if TYPE_CHECKING:
    from websockets.asyncio.client import ClientConnection

log = logging.getLogger("zantiflow.bot")

BackendMessage = Union[HelloAck, Deliver, LinkResult]
MessageHandler = Callable[[BackendMessage], Awaitable[None]]

# WebSocket keepalive (ping/pong). Ping the backend on this interval and, if no pong comes back within
# the timeout, treat the connection as dead → close + reconnect. The interval MUST stay below the
# backend's own idle-disconnect threshold (15 s, ADR-0007) so a healthy bot is never culled — a ping
# lands every ~10 s, well inside that window.
PING_INTERVAL = 10.0  # seconds between keepalive pings (< backend's 15 s idle cutoff)
PING_TIMEOUT = 5.0  # no pong within this window → disconnect + reconnect

# A connection that opens then drops almost immediately means the backend is FLAPPING — mid-restart, in
# a crash loop, or resetting the socket right after accept (the "no close frame received or sent" case).
# The reconnect backoff is reset to 1 s only once a connection has stayed up at least this long; a
# shorter-lived session leaves the backoff growing. Without this gate, resetting on mere socket-open
# turns a flapping backend into an endless ~1 Hz reconnect storm that hammers it and never lets it
# recover. Comfortably longer than a flap (sub-second to ~1 s) yet far shorter than a real session.
STABLE_CONNECTION_SEC = 5.0


def _terminate_process() -> None:
    """Signal our own process to shut down so the supervisor (docker ``restart: unless-stopped``, etc.)
    brings up a fresh bot. SIGTERM — not ``os._exit`` — so aiogram/discord.py run their graceful
    shutdown handlers on the way out. Isolated as a module function so tests can stub it (asserting the
    supervisor *would* terminate) without killing the test runner."""
    os.kill(os.getpid(), signal.SIGTERM)


class BotClient:
    def __init__(
        self,
        url: str,
        platform: Platform,
        service_secret: str,
        on_message: MessageHandler,
        ping_interval: float = PING_INTERVAL,
        ping_timeout: float = PING_TIMEOUT,
        stable_after: float = STABLE_CONNECTION_SEC,
    ) -> None:
        self.url = url
        self.platform = platform
        self.service_secret = service_secret
        self.on_message = on_message
        self.ping_interval = ping_interval
        self.ping_timeout = ping_timeout
        self.stable_after = stable_after
        self._ws: Optional[ClientConnection] = None
        self._task: "Optional[asyncio.Task[None]]" = None

    def _hello_json(self) -> str:
        return json.dumps(
            {
                "kind": "hello",
                "platform": self.platform,
                "serviceSecret": self.service_secret,
                "version": PROTOCOL_VERSION,
            }
        )

    async def send(self, msg: object) -> None:
        """Send a bot->backend message (a pydantic model)."""
        if self._ws is not None:
            await self._ws.send(msg.model_dump_json(exclude_none=True))  # type: ignore[attr-defined]

    def start(self) -> "asyncio.Task[None]":
        """Launch ``run_forever()`` as a *supervised* background task and return it.

        Prefer this over a bare ``asyncio.create_task(self.run_forever())``, which gets two things wrong:

        - asyncio keeps only a WEAK reference to a task, so an un-kept one can be garbage-collected
          mid-flight ("Task was destroyed but it is pending!"). We hold the reference on the instance.
        - ``run_forever`` is meant to loop forever, so its finishing at all is a *fault*. A bare task
          would let the exception vanish ("Task exception was never retrieved") and the bot would keep
          serving Discord/Telegram while silently no longer talking to the backend. The done-callback
          turns any unexpected exit into a loud log + process termination, so the supervisor restarts a
          fresh, fully-working bot instead of leaving a half-dead one. A clean cancel is exempt.
        """
        task = asyncio.create_task(self.run_forever())
        self._task = task
        task.add_done_callback(self._on_task_done)
        return task

    def _on_task_done(self, task: "asyncio.Task[None]") -> None:
        if task.cancelled():
            return  # graceful shutdown (the task was cancelled) — expected, not a fault
        exc = task.exception()
        if exc is not None:
            log.critical("bot ws loop crashed; terminating to trigger restart", exc_info=exc)
        else:
            log.critical("bot ws loop exited unexpectedly; terminating to trigger restart")
        _terminate_process()

    async def run_forever(self, max_backoff: float = 30.0) -> None:
        backoff = 1.0
        while True:
            opened_at: Optional[float] = None  # set when the socket actually opens; None if connect failed
            try:
                async with websockets.connect(
                    self.url, ping_interval=self.ping_interval, ping_timeout=self.ping_timeout
                ) as ws:
                    opened_at = time.monotonic()
                    self._ws = ws
                    await ws.send(self._hello_json())
                    async for raw in ws:
                        text = raw if isinstance(raw, str) else raw.decode()
                        try:
                            msg = parse_backend_message(text)
                        except Exception:  # noqa: BLE001 — never let one bad frame kill the loop
                            log.warning("dropping unparseable frame")
                            continue
                        await self.on_message(msg)
            except Exception as e:  # noqa: BLE001
                log.warning("ws disconnected: %s; reconnecting in %.1fs", e, backoff)
            finally:
                self._ws = None
            # Only a connection that stayed up past the stability window counts as "healthy"; reset the
            # backoff so a genuine single blip reconnects fast. A socket that opened then dropped almost
            # immediately (a flapping backend) leaves the backoff growing so we don't storm it — and a
            # connect that never opened (opened_at is None) likewise keeps backing off.
            if opened_at is not None and (time.monotonic() - opened_at) >= self.stable_after:
                backoff = 1.0
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)
