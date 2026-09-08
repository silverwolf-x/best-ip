from __future__ import annotations

import asyncio
import shutil
import threading
from pathlib import Path
from typing import Any

import pytest
import yaml

import backend.app.mihomo as mihomo_module
from backend.app.mihomo import (
    MIHOMO_NOT_READY_MESSAGE,
    MihomoError,
    MihomoNotReadyError,
    MihomoProcess,
    MihomoStopError,
)


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


async def test_start_rejects_missing_core_before_creating_workspace(tmp_path) -> None:
    work_dir = tmp_path / "workspace"
    mihomo = MihomoProcess(
        tmp_path / "missing-mihomo.exe",
        work_dir,
        [{"name": "node-a"}],
    )

    with pytest.raises(MihomoNotReadyError, match="核心未就绪") as caught:
        await mihomo.start()

    assert str(caught.value) == MIHOMO_NOT_READY_MESSAGE
    assert work_dir.exists() is False


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
    await mihomo._release_ports()


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


async def test_concurrent_starts_overlap_and_use_distinct_reserved_ports(
    tmp_path,
    monkeypatch,
) -> None:
    processes: list[FakeProcess] = []
    ready_release = asyncio.Event()
    ready_active = 0
    max_ready_active = 0

    async def fake_spawn(*_args: Any, **_kwargs: Any) -> FakeProcess:
        process = FakeProcess()
        processes.append(process)
        return process

    async def concurrent_ready(_self: MihomoProcess) -> None:
        nonlocal ready_active, max_ready_active
        ready_active += 1
        max_ready_active = max(max_ready_active, ready_active)
        try:
            await ready_release.wait()
        finally:
            ready_active -= 1

    monkeypatch.setattr(
        "backend.app.mihomo.asyncio.create_subprocess_exec",
        fake_spawn,
    )
    monkeypatch.setattr(MihomoProcess, "_wait_until_ready", concurrent_ready)
    core_path = tmp_path / "mihomo.exe"
    core_path.write_bytes(b"")
    instances = [
        MihomoProcess(
            core_path,
            tmp_path / f"workspace-{index}",
            [{"name": f"node-{index}"}],
        )
        for index in range(2)
    ]
    tasks = [asyncio.create_task(instance.start()) for instance in instances]

    try:
        deadline = asyncio.get_running_loop().time() + 2
        while (
            len(processes) < 2
            or max_ready_active < 2
        ) and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        assert len(processes) == 2
        assert max_ready_active == 2
        assert len({instance.mixed_port for instance in instances}) == 2
        assert len({instance.controller_port for instance in instances}) == 2
        assert set(instance.mixed_port for instance in instances).isdisjoint(
            instance.controller_port for instance in instances
        )
    finally:
        ready_release.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*(instance.stop() for instance in instances))

    assert all(instance._ports_reserved is False for instance in instances)
    assert all(
        port not in mihomo_module._RESERVED_PORTS
        for instance in instances
        for port in (instance.mixed_port, instance.controller_port)
    )


async def test_start_cancellation_waits_for_config_thread_and_releases_ports(
    tmp_path,
    monkeypatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    original_write_config = MihomoProcess._write_config

    def slow_write_config(self: MihomoProcess) -> Path:
        entered.set()
        assert release.wait(5)
        return original_write_config(self)

    monkeypatch.setattr(MihomoProcess, "_write_config", slow_write_config)
    core_path = tmp_path / "mihomo.exe"
    core_path.write_bytes(b"")
    work_dir = tmp_path / "workspace"
    mihomo = MihomoProcess(core_path, work_dir, [{"name": "node-a"}])
    task = asyncio.create_task(mihomo.start())

    assert await asyncio.to_thread(entered.wait, 5)
    task.cancel()
    await asyncio.sleep(0)
    release.set()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert mihomo._ports_reserved is False
    assert (work_dir / "config.yaml").is_file()
    shutil.rmtree(work_dir)


async def test_failed_readiness_releases_reserved_ports(tmp_path, monkeypatch) -> None:
    async def fake_spawn(*_args: Any, **_kwargs: Any) -> FakeProcess:
        return FakeProcess()

    async def fail_ready(_self: MihomoProcess) -> None:
        raise MihomoError("controller unavailable")

    monkeypatch.setattr(
        "backend.app.mihomo.asyncio.create_subprocess_exec",
        fake_spawn,
    )
    monkeypatch.setattr(MihomoProcess, "_wait_until_ready", fail_ready)
    core_path = tmp_path / "mihomo.exe"
    core_path.write_bytes(b"")
    mihomo = MihomoProcess(core_path, tmp_path / "workspace", [{"name": "node-a"}])

    with pytest.raises(MihomoError, match="Mihomo 启动失败"):
        await mihomo.start()

    assert mihomo._ports_reserved is False
    assert mihomo.process is None
    assert mihomo.mixed_port not in mihomo_module._RESERVED_PORTS
    assert mihomo.controller_port not in mihomo_module._RESERVED_PORTS


async def test_unsupported_subprocess_loop_reports_runtime_error(tmp_path, monkeypatch) -> None:
    async def unsupported_spawn(*_args: Any, **_kwargs: Any) -> None:
        raise NotImplementedError("private runtime detail")

    monkeypatch.setattr(mihomo_module.asyncio, "create_subprocess_exec", unsupported_spawn)
    core_path = tmp_path / "mihomo.exe"
    core_path.write_bytes(b"")
    mihomo = MihomoProcess(core_path, tmp_path / "workspace", [{"name": "node-a"}])

    with pytest.raises(MihomoNotReadyError) as caught:
        await mihomo.start()

    assert str(caught.value) == mihomo_module.MIHOMO_SUBPROCESS_UNSUPPORTED_MESSAGE
    assert "private runtime detail" not in str(caught.value)
    assert mihomo.process is None
    assert mihomo._log_handle is None
    assert mihomo._ports_reserved is False
    assert mihomo.mixed_port not in mihomo_module._RESERVED_PORTS
    assert mihomo.controller_port not in mihomo_module._RESERVED_PORTS


async def test_select_returns_preselected_single_member_without_put(
    tmp_path,
    monkeypatch,
) -> None:
    put_called = False

    class Response:
        is_success = True

        @staticmethod
        def json() -> dict[str, str]:
            return {"now": "node-a"}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def get(self, _url: str, *, headers: dict[str, str]) -> Response:
            assert headers["Authorization"].startswith("Bearer ")
            return Response()

        async def put(self, *_args: Any, **_kwargs: Any) -> None:
            nonlocal put_called
            put_called = True
            raise AssertionError("单成员 selector 不应执行冗余 PUT")

    monkeypatch.setattr(
        "backend.app.mihomo.httpx.AsyncClient",
        lambda **_kwargs: Client(),
    )
    mihomo = MihomoProcess(
        tmp_path / "mihomo.exe",
        tmp_path / "workspace",
        [{"name": "node-a", "type": "ss"}],
        selector_names=["node-a"],
    )
    mihomo.controller_port = 12345

    assert await mihomo.select("node-a") == "node-a"
    assert put_called is False


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


async def test_start_writes_physical_interface_and_independent_dns(
    tmp_path,
    monkeypatch,
) -> None:
    process = FakeProcess()

    async def fake_spawn(*_args: Any, **_kwargs: Any) -> FakeProcess:
        return process

    async def ready(_self: MihomoProcess) -> None:
        return None

    monkeypatch.setattr(
        "backend.app.mihomo.asyncio.create_subprocess_exec",
        fake_spawn,
    )
    monkeypatch.setattr(MihomoProcess, "_wait_until_ready", ready)
    core_path = tmp_path / "mihomo.exe"
    core_path.write_bytes(b"")
    mihomo = MihomoProcess(
        core_path,
        tmp_path / "workspace",
        [
            {"name": "node-a", "type": "ss"},
            {"name": "bootstrap-node", "type": "ss", "server": "1.2.3.4"},
        ],
        outbound_interface="WLAN",
        dns_bootstrap_proxy="bootstrap-node",
    )

    await mihomo.start()
    config = yaml.safe_load((mihomo.work_dir / "config.yaml").read_text("utf-8"))
    await mihomo.stop()

    assert config["interface-name"] == "WLAN"
    assert config["dns"]["enhanced-mode"] == "redir-host"
    assert config["dns"]["respect-rules"] is False
    assert "nameserver-policy" not in config["dns"]
    assert all(
        resolver.endswith("#BEST-IP-DNS")
        for resolver in config["dns"]["proxy-server-nameserver"]
    )
    dns_group = next(
        group
        for group in config["proxy-groups"]
        if group["name"] == "BEST-IP-DNS"
    )
    assert dns_group["proxies"] == ["bootstrap-node"]
    controller_port = int(config["external-controller"].rsplit(":", 1)[-1])
    assert config["mixed-port"] != controller_port
    assert "DOMAIN,ipure.dev,BEST-IP" in config["rules"]
