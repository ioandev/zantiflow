"""zantiflow backend<->bot notification protocol (ADR-0007/0010).

The Node backend is the source of truth (``packages/protocol/src/botws.ts``); these pydantic models
mirror it so the Python bots parse/emit the same JSON. ``PROTOCOL_VERSION`` guards major skew.
"""

from .client import BotClient
from .handlers import handle_deliver
from .models import (
    PROTOCOL_VERSION,
    BackendToBot,
    BotToBackend,
    Deliver,
    DeliveryResult,
    Hello,
    HelloAck,
    LinkRequest,
    LinkResult,
    UnlinkNotice,
    parse_backend_message,
)

__all__ = [
    "PROTOCOL_VERSION",
    "BackendToBot",
    "BotClient",
    "BotToBackend",
    "Deliver",
    "DeliveryResult",
    "Hello",
    "HelloAck",
    "LinkRequest",
    "LinkResult",
    "UnlinkNotice",
    "handle_deliver",
    "parse_backend_message",
]
