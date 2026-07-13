"""The reconnecting client keeps the connection alive with WebSocket ping/pong: it configures
websockets.connect with ping_interval/ping_timeout so a dead backend is detected and reconnected."""

import asyncio

import pytest

import zantiflow_notify.client as client


class _Stop(Exception):
    """Raised from a patched asyncio.sleep to break run_forever's otherwise-infinite loop."""


async def _noop(_msg):
    return None


async def test_run_forever_passes_keepalive_to_connect(monkeypatch):
    captured = {}

    def fake_connect(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        raise ConnectionError("no server")  # fail the attempt → drop into the reconnect/backoff path

    async def fake_sleep(_delay):
        raise _Stop  # stop after the first backoff so the loop terminates

    monkeypatch.setattr(client.websockets, "connect", fake_connect)
    monkeypatch.setattr(client.asyncio, "sleep", fake_sleep)

    bc = client.BotClient("ws://x/y", "telegram", "s", _noop, ping_interval=13.0, ping_timeout=5.0)
    with pytest.raises(_Stop):
        await bc.run_forever()

    assert captured["url"] == "ws://x/y"
    assert captured["ping_interval"] == 13.0
    assert captured["ping_timeout"] == 5.0


async def test_default_ping_timeout_is_five_seconds():
    bc = client.BotClient("ws://x/y", "telegram", "s", _noop)
    assert bc.ping_timeout == 5.0
    assert client.PING_TIMEOUT == 5.0
    assert bc.ping_interval == client.PING_INTERVAL


class _FakeWS:
    """A socket that opens and then immediately reports the connection closed (empty message stream)."""

    async def send(self, _msg):
        return None

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration  # connection dropped right after open → the async-for ends at once


class _FakeConnect:
    async def __aenter__(self):
        return _FakeWS()

    async def __aexit__(self, *_a):
        return False


def _capture_sleeps(monkeypatch, stop_after):
    """Patch asyncio.sleep to record each backoff delay and stop the loop after `stop_after` sleeps."""
    sleeps: list[float] = []

    async def fake_sleep(delay):
        sleeps.append(delay)
        if len(sleeps) >= stop_after:
            raise _Stop

    monkeypatch.setattr(client.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(client.websockets, "connect", lambda url, **kw: _FakeConnect())
    return sleeps


async def test_flapping_backend_keeps_backing_off(monkeypatch):
    """A backend that accepts the socket then instantly drops it (mid-restart / crash loop) must NOT
    reset the backoff — otherwise the client reconnect-storms at ~1 Hz forever (the reported bug)."""
    sleeps = _capture_sleeps(monkeypatch, stop_after=4)
    # monotonic returns the same instant on open and on the reset check → uptime 0 < STABLE_CONNECTION_SEC.
    monkeypatch.setattr(client.time, "monotonic", lambda: 100.0)

    bc = client.BotClient("ws://x/y", "telegram", "s", _noop)
    with pytest.raises(_Stop):
        await bc.run_forever()

    assert sleeps == [1.0, 2.0, 4.0, 8.0]  # strictly growing — no reset-to-1.0 on the flap


async def test_stable_connection_resets_backoff(monkeypatch):
    """A connection that stays up past the stability window resets the backoff, so a later single blip
    reconnects quickly instead of inheriting a grown delay."""
    sleeps = _capture_sleeps(monkeypatch, stop_after=3)
    clock = {"t": 0.0}

    def fake_monotonic():
        clock["t"] += 100.0  # every call jumps 100 s → uptime always >> STABLE_CONNECTION_SEC
        return clock["t"]

    monkeypatch.setattr(client.time, "monotonic", fake_monotonic)

    bc = client.BotClient("ws://x/y", "telegram", "s", _noop)
    with pytest.raises(_Stop):
        await bc.run_forever()

    assert sleeps == [1.0, 1.0, 1.0]  # each stable session resets → fast reconnect every time


class _FakeTask:
    """A stand-in for asyncio.Task exposing just the outcome accessors the done-callback inspects."""

    def __init__(self, *, cancelled=False, exc=None):
        self._cancelled = cancelled
        self._exc = exc

    def cancelled(self):
        return self._cancelled

    def exception(self):
        return self._exc


def test_supervisor_terminates_when_loop_crashes(monkeypatch):
    """An unexpected exception escaping run_forever must terminate the process (→ supervisor restart),
    not vanish silently and leave the bot serving chat with a dead backend link."""
    terminated = []
    monkeypatch.setattr(client, "_terminate_process", lambda: terminated.append(True))
    bc = client.BotClient("ws://x/y", "telegram", "s", _noop)
    bc._on_task_done(_FakeTask(exc=RuntimeError("boom")))
    assert terminated == [True]


def test_supervisor_terminates_when_loop_exits_cleanly_but_unexpectedly(monkeypatch):
    """run_forever returning at all is a fault (it should loop forever) → still terminate."""
    terminated = []
    monkeypatch.setattr(client, "_terminate_process", lambda: terminated.append(True))
    bc = client.BotClient("ws://x/y", "telegram", "s", _noop)
    bc._on_task_done(_FakeTask())  # finished, no exception
    assert terminated == [True]


def test_supervisor_ignores_clean_cancellation(monkeypatch):
    """A cancelled task is graceful shutdown, not a fault — the process must be left alone."""
    terminated = []
    monkeypatch.setattr(client, "_terminate_process", lambda: terminated.append(True))
    bc = client.BotClient("ws://x/y", "telegram", "s", _noop)
    bc._on_task_done(_FakeTask(cancelled=True))
    assert terminated == []


async def test_start_keeps_a_reference_and_wires_supervision(monkeypatch):
    """start() must retain the task (asyncio only weakly references it) and attach the done-callback so
    an unexpected exit is actually caught."""
    terminated = []
    monkeypatch.setattr(client, "_terminate_process", lambda: terminated.append(True))

    async def instant(self, max_backoff=30.0):
        return None  # simulate run_forever exiting unexpectedly right away

    monkeypatch.setattr(client.BotClient, "run_forever", instant)

    bc = client.BotClient("ws://x/y", "telegram", "s", _noop)
    task = bc.start()
    assert bc._task is task  # reference held on the instance → not garbage-collectable mid-flight
    await task
    for _ in range(3):  # let the scheduled done-callback run
        await asyncio.sleep(0)
    assert terminated == [True]
