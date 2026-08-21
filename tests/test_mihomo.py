from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from backend.app.mihomo import MihomoProcess, MihomoStopError


class FakeProcess:
    returncode = None
    terminated = False
    killed = False

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True

    async def wait(self) -> None:
        return None


class FakeLogHandle:
    closed = False

    def close(self) -> None:
        self.closed = True


async def test_start_cancellation_stops_spawned_process(tmp_path, monkeypatch) -> None:
    started = asyncio.Event()
    stop_called = False

    async def fake_spawn(*_args: Any, **_kwargs: Any) -> FakeProcess:
        return FakeProcess()

    async def wait_forever(_self: MihomoProcess) -> None:
        started.set()
        await asyncio.Event().wait()

    async def fake_stop(_self: MihomoProcess) -> None:
        nonlocal stop_called
        stop_called = True

    monkeypatch.setattr(
        "backend.app.mihomo.asyncio.create_subprocess_exec",
        fake_spawn,
    )
    monkeypatch.setattr(MihomoProcess, "_wait_until_ready", wait_forever)
    monkeypatch.setattr(MihomoProcess, "stop", fake_stop)
    core_path = tmp_path / "mihomo.exe"
    core_path.write_bytes(b"")
    mihomo = MihomoProcess(
        core_path,
        tmp_path / "workspace",
        [{"name": "node-a"}],
    )

    task = asyncio.create_task(mihomo.start())
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert stop_called is True


async def test_stop_reports_unconfirmed_process_exit(tmp_path, monkeypatch) -> None:
    async def fail_wait(awaitable: Any, *, timeout: float) -> None:
        assert timeout == 8
        awaitable.close()
        raise TimeoutError

    monkeypatch.setattr("backend.app.mihomo.asyncio.wait_for", fail_wait)
    mihomo = MihomoProcess(
        Path("mihomo.exe"),
        tmp_path,
        [{"name": "node-a"}],
    )
    process = FakeProcess()
    log_handle = FakeLogHandle()
    mihomo.process = process  # type: ignore[assignment]
    mihomo._log_handle = log_handle

    with pytest.raises(MihomoStopError, match="未能停止"):
        await mihomo.stop()

    assert process.terminated is True
    assert process.killed is True
    assert mihomo.process is process
    assert log_handle.closed is False


async def test_stop_wraps_unexpected_cleanup_error(tmp_path, monkeypatch) -> None:
    async def fail_stop(_process: Any) -> None:
        raise PermissionError("access denied")

    monkeypatch.setattr(
        MihomoProcess,
        "_stop_process",
        staticmethod(fail_stop),
    )
    mihomo = MihomoProcess(
        Path("mihomo.exe"),
        tmp_path,
        [{"name": "node-a"}],
    )
    process = FakeProcess()
    log_handle = FakeLogHandle()
    mihomo.process = process  # type: ignore[assignment]
    mihomo._log_handle = log_handle

    with pytest.raises(MihomoStopError, match="停止失败"):
        await mihomo.stop()

    assert mihomo.process is process
    assert log_handle.closed is False


async def test_stop_finishes_cleanup_before_propagating_cancellation(
    tmp_path,
    monkeypatch,
) -> None:
    started = asyncio.Event()
    finish = asyncio.Event()
    cleaned = False

    async def controlled_stop(_process: Any) -> None:
        nonlocal cleaned
        started.set()
        await finish.wait()
        cleaned = True

    monkeypatch.setattr(
        MihomoProcess,
        "_stop_process",
        staticmethod(controlled_stop),
    )
    mihomo = MihomoProcess(
        Path("mihomo.exe"),
        tmp_path,
        [{"name": "node-a"}],
    )
    log_handle = FakeLogHandle()
    mihomo.process = FakeProcess()  # type: ignore[assignment]
    mihomo._log_handle = log_handle

    task = asyncio.create_task(mihomo.stop())
    await started.wait()
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(0)
    assert task.done() is False
    finish.set()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert cleaned is True
    assert mihomo.process is None
    assert log_handle.closed is True
