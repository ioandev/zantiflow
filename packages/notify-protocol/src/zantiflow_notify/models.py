"""Pydantic v2 models for the botws protocol — the exact mirror of ``packages/protocol/src/botws.ts``.

Each message carries a ``kind`` discriminator. ``BotToBackend`` / ``BackendToBot`` are the tagged
unions; ``parse_backend_message`` validates an inbound JSON string into the right model.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, TypeAdapter

PROTOCOL_VERSION = 1

Platform = Literal["discord", "telegram"]


# --- bot -> backend ---
class Hello(BaseModel):
    kind: Literal["hello"] = "hello"
    platform: Platform
    serviceSecret: str
    version: int = PROTOCOL_VERSION


class LinkRequest(BaseModel):
    kind: Literal["link_request"] = "link_request"
    platform: Platform
    platformUserId: str
    platformUsername: Optional[str] = None
    token: str


class DeliveryResult(BaseModel):
    kind: Literal["delivery_result"] = "delivery_result"
    deliveryId: str
    status: Literal["delivered", "failed"]
    error: Optional[str] = None


class UnlinkNotice(BaseModel):
    kind: Literal["unlink_notice"] = "unlink_notice"
    platform: Platform
    platformUserId: str
    reason: str


BotToBackend = Annotated[
    Union[Hello, LinkRequest, DeliveryResult, UnlinkNotice],
    Field(discriminator="kind"),
]


# --- backend -> bot ---
class HelloAck(BaseModel):
    kind: Literal["hello_ack"] = "hello_ack"
    ok: bool


class Deliver(BaseModel):
    kind: Literal["deliver"] = "deliver"
    deliveryId: str
    platformUserId: str
    text: str


class LinkResult(BaseModel):
    kind: Literal["link_result"] = "link_result"
    token: str
    ok: bool
    # Echoed back from the link_request so the bot knows WHICH user to DM the confirmation to.
    platformUserId: Optional[str] = None
    accountLabel: Optional[str] = None
    error: Optional[str] = None


BackendToBot = Annotated[
    Union[HelloAck, Deliver, LinkResult],
    Field(discriminator="kind"),
]

_backend_adapter: TypeAdapter = TypeAdapter(BackendToBot)


def parse_backend_message(raw: str) -> Union[HelloAck, Deliver, LinkResult]:
    """Validate an inbound backend->bot JSON message into its model."""
    return _backend_adapter.validate_json(raw)
