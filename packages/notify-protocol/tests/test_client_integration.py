"""End-to-end reproduction of the 'stuck bots' incident against a REAL flapping WebSocket server.

Unlike the deterministic unit tests (test_client.py), this drives the shipped ``BotClient`` over a real
localhost socket with real wall-clock timing. It reproduces the incident's exact condition — the server
accepts each connection, holds it long enough for the client to finish its hello and enter the receive
loop, then aborts the TCP with no close frame ("no close frame received or sent") — and asserts the
client BACKS OFF (growing reconnect gaps) instead of storming at ~1 Hz (the reported bug).

Gated behind the ``integration`` marker (real timing → slower/flakier), so it's excluded from the
default run. Execute with:  pytest -m integration
"""

import asyncio
import logging
import time

import pytest
import websockets

import zantiflow_notify.client as client

pytestmark = pytest.mark.integration


async def _noop(_msg):
    return None


class _Capture(logging.Handler):
    """Collects the client's WARNING logs so we can assert the exact disconnect reason."""

    def __init__(self):
        super().__init__()
        self.msgs: list[str] = []

    def emit(self, record):
        self.msgs.append(record.getMessage())


async def test_client_backs_off_against_a_real_flapping_backend():
    accepts: list[float] = []

    async def flap(ws):
        accepts.append(time.monotonic())
        # Let the client fully connect + send hello + enter its receive loop (as in the incident, where
        # the socket lived long enough to reach the backoff reset), THEN abort the TCP with no close
        # frame — reproducing the exact `no close frame received or sent` disconnect.
        await asyncio.sleep(0.1)
        try:
            ws.transport.abort()
        except Exception:  # noqa: BLE001 — fall back to a normal close if transport.abort is unavailable
            await ws.close()

    cap = _Capture()
    log = logging.getLogger("zantiflow.bot")
    log.addHandler(cap)
    prev_level = log.level
    log.setLevel(logging.WARNING)
    task: "asyncio.Task[None] | None" = None
    try:
        async with websockets.serve(flap, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            bc = client.BotClient(f"ws://127.0.0.1:{port}/internal/bots", "telegram", "s", _noop, stable_after=5.0)
            task = asyncio.create_task(bc.run_forever())
            # ~6.5 s reliably captures three reconnects — gaps ~1 s then ~2 s (backoff) — with margin
            # for slower CI runners, but stops before the fourth (~7.3 s). Backoff sleeps are wall-clock
            # floors, so a slow runner only pushes reconnects LATER, never sooner.
            await asyncio.sleep(6.5)
    finally:
        if task is not None:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        log.removeHandler(cap)
        log.setLevel(prev_level)

    gaps = [accepts[i + 1] - accepts[i] for i in range(len(accepts) - 1)]

    # Faithful reproduction: the client saw the incident's exact disconnect reason.
    disconnects = [m for m in cap.msgs if m.startswith("ws disconnected")]
    assert any("no close frame received or sent" in m for m in disconnects), disconnects

    # The fix: it backed off. A storm (the bug) would reconnect ~1 s apart every time — many attempts,
    # flat gaps. Backoff means few attempts and each gap clearly larger than the last.
    assert len(accepts) <= 4, f"expected few reconnects (backoff), got {len(accepts)}: {gaps}"
    assert len(gaps) >= 2, f"need at least two gaps to prove growth, got {gaps}"
    assert gaps[1] - gaps[0] >= 0.5, f"second gap should be ~1 s longer (backoff), not flat: {gaps}"
