"""Platform-agnostic handling of backend->bot messages (ADR-0007). Kept here (not in each bot) so the
delivery flow — DM the user, then ack — is written once and unit-tested without a live Discord/Telegram
connection. The bots inject their own ``dm`` and ``send`` callables.
"""

from __future__ import annotations

from typing import Awaitable, Callable

from .models import Deliver, DeliveryResult

# dm(platform_user_id, text) -> delivered?   send(message) -> None
DmFn = Callable[[str, str], Awaitable[bool]]
SendFn = Callable[[object], Awaitable[None]]


async def handle_deliver(msg: Deliver, dm: DmFn, send: SendFn) -> bool:
    """DM the target user and report the result back over the WS (idempotency lives in ``deliveryId``)."""
    ok = await dm(msg.platformUserId, msg.text)
    await send(
        DeliveryResult(
            deliveryId=msg.deliveryId,
            status="delivered" if ok else "failed",
            error=None if ok else "dm_failed",
        )
    )
    return ok
