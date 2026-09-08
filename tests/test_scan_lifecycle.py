from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from backend.app.config import Settings
from backend.app.main import create_app
from backend.app.mihomo import MIHOMO_NOT_READY_MESSAGE, MihomoNotReadyError, MihomoStopError
from backend.app.results.store import ResultStore
from backend.app.scan.errors import classify_error
from backend.app.scan.jobs import JobNotReadyError, ScanJobManager
from backend.app.scan.node_runner import NodeRunner


@pytest.fixture
def scenario(tmp_path):
    state = SimpleNamespace(
        cores=[],
        collect=asyncio.Event(),
        stop=asyncio.Event(),
        release=None,
        environment_failure=False,
        parallel_environment_failure=False,
        stop_failure=False,
        selected_name=None,
    )

    class Core:
        group_name = "BEST-IP"

        def __init__(self, _binary, work_dir, proxies, **kwargs):
            self.work_dir = work_dir
            self.proxies = proxies
            self.outbound_interface = kwargs["outbound_interface"]
            self.dns_bootstrap_proxy = kwargs["dns_bootstrap_proxy"]
            self.instance_id = f"core-{len(state.cores)}"
            self.proxy_url = f"http://127.0.0.1:{21000 + len(state.cores)}"
            self.stopped = False
            state.cores.append(self)

        async def start(self):
            self.work_dir.mkdir(parents=True)
            if state.parallel_environment_failure and self.proxies[0]["name"] == "node-0":
                await state.collect.wait()
                raise MihomoNotReadyError(MIHOMO_NOT_READY_MESSAGE)
            if state.environment_failure:
                raise MihomoNotReadyError(MIHOMO_NOT_READY_MESSAGE)

        async def select(self, name):
            return state.selected_name or name

        def log_offset(self):
            return 0

        def read_log_since(self, _offset):
            return ""

        async def stop(self):
            state.stop.set()
            if state.release is not None:
                await state.release.wait()
            if state.stop_failure:
                raise MihomoStopError("secret process details")
            self.stopped = True

    class Collector:
        def __init__(self, *_args, **_kwargs):
            pass

        async def collect(self, **_kwargs):
            state.collect.set()
            await asyncio.Event().wait()

    settings = Settings(
        mihomo_path=Path(__file__),
        max_parallel_nodes=1,
        max_node_attempts=3,
        node_retry_backoff_ms=0,
    )
    runner = NodeRunner(settings, mihomo_factory=Core, collector_factory=Collector)

    async def download(_url: str, **_kwargs: Any) -> bytes:
        return b"synthetic subscription"

    def parse(_content: bytes, **_kwargs: Any) -> list[dict[str, Any]]:
        return [
            {"name": f"node-{index}", "type": "ss", "server": "192.0.2.1"} for index in range(3)
        ]

    state.manager = ScanJobManager(
        settings,
        ResultStore(tmp_path / "results"),
        tmp_path / "jobs",
        node_runner=runner,
        download=download,
        parse=parse,
        resolve_interface=lambda _configured: None,
    )
    state.runner = runner
    state.proxy = parse(b"")[0]
    state.run = lambda: runner.run(
        job_id="node-job",
        work_dir=tmp_path / "job",
        proxies=[state.proxy],
        proxy=state.proxy,
        index=0,
        dns_bootstrap_candidates=[],
        outbound_interface=None,
    )
    return state


@pytest.mark.asyncio
async def test_wait_timeout_does_not_cancel_scan(scenario):
    manager = scenario.manager
    created = manager.create("https://example.invalid/subscription")
    await asyncio.wait_for(scenario.collect.wait(), 2)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(manager.wait(created["id"]), 0.01)
    assert manager.get(created["id"])["status"] == "running"
    assert not scenario.cores[0].stopped
    cancelled = await manager.cancel(created["id"])
    assert cancelled["status"] == "cancelled"
    assert cancelled["cleanup_confirmed"] is True
    assert scenario.cores[0].stopped
    assert not scenario.cores[0].work_dir.exists()
    assert (await manager.wait(created["id"]))["status"] == "cancelled"


@pytest.mark.asyncio
async def test_environment_failure_stops_subscription_without_node_records(scenario):
    scenario.environment_failure = True
    manager = scenario.manager
    created = manager.create("https://example.invalid/subscription")
    job = await manager.wait(created["id"])
    assert job["status"] == "failed"
    assert job["completed"] == 0
    assert job["results"] == []
    assert job["cleanup_confirmed"] is True
    assert len(scenario.cores) == 1
    assert scenario.cores[0].stopped
    error = manager.get_error(created["id"])
    assert (error.code, error.phase, error.retryable) == ("environment_not_ready", "start", False)
    assert job["error_details"] == {
        "code": error.code,
        "phase": "start",
        "retryable": False,
        "message": error.message,
    }


@pytest.mark.asyncio
async def test_repeated_cancel_waits_for_stop_before_removing_directory(scenario):
    scenario.release = asyncio.Event()
    operation = asyncio.create_task(scenario.run())
    await asyncio.wait_for(scenario.collect.wait(), 2)
    operation.cancel()
    await asyncio.wait_for(scenario.stop.wait(), 2)
    operation.cancel()
    await asyncio.sleep(0)
    assert not operation.done()
    assert scenario.cores[0].work_dir.exists()
    assert not scenario.cores[0].stopped
    scenario.release.set()
    with pytest.raises(asyncio.CancelledError):
        await operation
    assert scenario.cores[0].stopped
    assert not scenario.cores[0].work_dir.exists()


@pytest.mark.asyncio
async def test_cleanup_failure_remains_visible_and_preserves_work_directory(scenario):
    scenario.stop_failure = True
    manager = scenario.manager
    created = manager.create("https://example.invalid/subscription")
    await asyncio.wait_for(scenario.collect.wait(), 2)
    with pytest.raises(JobNotReadyError):
        await manager.cancel(created["id"])
    job = manager.get(created["id"])
    assert job["status"] == "failed"
    assert job["cleanup_confirmed"] is False
    assert job["manifest_ready"] is False
    assert scenario.cores[0].work_dir.exists()
    assert "secret" not in str(job)
    assert manager.get_error(created["id"]).code == "cleanup_failed"
    with pytest.raises(JobNotReadyError):
        await manager.shutdown()


@pytest.mark.asyncio
async def test_selector_confirmation_precedes_collection(scenario):
    scenario.selected_name = "another-node"
    outcome = await scenario.run()
    assert not scenario.collect.is_set()
    assert outcome.record["status"] == "failed"
    assert outcome.record["exit_ip"] is None
    assert outcome.error.code == "selector_unconfirmed"
    assert outcome.error.phase == "select"
    assert all(core.stopped for core in scenario.cores)


@pytest.mark.asyncio
async def test_cancel_before_workers_start_cleans_workspace(scenario, monkeypatch):
    manager = scenario.manager
    entered = asyncio.Event()
    original = manager._write_progress

    async def block_running(job, *, force=False):
        if job["status"] == "running":
            (manager.workspace / job["id"]).mkdir(parents=True)
            entered.set()
            await asyncio.Event().wait()
        await original(job, force=force)

    monkeypatch.setattr(manager, "_write_progress", block_running)
    created = manager.create("https://example.invalid/subscription")
    await asyncio.wait_for(entered.wait(), 2)
    job = await manager.cancel(created["id"])
    assert job["status"] == "cancelled"
    assert job["cleanup_confirmed"] is True
    assert job["error_details"] is None
    assert scenario.cores == []
    assert not (manager.workspace / created["id"]).exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("through_api", [False, True])
async def test_concurrent_cancellation_waits_for_single_cleanup(scenario, through_api):
    scenario.release = asyncio.Event()
    manager = scenario.manager
    created = manager.create("https://example.invalid/subscription")
    await asyncio.wait_for(scenario.collect.wait(), 2)
    async with AsyncClient(
        transport=ASGITransport(app=create_app(scan_service=manager)), base_url="http://test"
    ) as client:

        async def cancel():
            if through_api:
                response = await client.delete(f"/api/scans/{created['id']}")
                assert response.status_code == 200
                return response.json()
            return await manager.cancel(created["id"])

        first = asyncio.create_task(cancel())
        await asyncio.wait_for(scenario.stop.wait(), 2)
        second = asyncio.create_task(cancel())
        await asyncio.sleep(0)
        assert not first.done() and not second.done()
        assert scenario.cores[0].work_dir.exists()
        scenario.release.set()
        jobs = await asyncio.wait_for(asyncio.gather(first, second), 2)
    assert all(job["status"] == "cancelled" and job["cleanup_confirmed"] for job in jobs)
    assert len(scenario.cores) == 1
    assert scenario.cores[0].stopped
    assert not (manager.workspace / created["id"]).exists()


@pytest.mark.asyncio
async def test_parallel_environment_failure_cancels_sibling_worker(scenario):
    scenario.parallel_environment_failure = True
    manager = scenario.manager
    manager.node_parallelism = 2
    created = manager.create("https://example.invalid/subscription")
    job = await asyncio.wait_for(manager.wait(created["id"]), 2)
    assert job["status"] == "failed"
    assert job["error_details"]["code"] == "environment_not_ready"
    assert job["completed"] == 0
    assert job["metrics"]["active_nodes"] == 0
    assert len(scenario.cores) == 2
    assert all(core.stopped for core in scenario.cores)
    assert job["cleanup_confirmed"] is True
    assert not (manager.workspace / created["id"]).exists()


@pytest.mark.asyncio
async def test_api_cancel_returns_500_when_cleanup_fails(scenario):
    scenario.stop_failure = True
    manager = scenario.manager
    created = manager.create("https://example.invalid/subscription")
    await asyncio.wait_for(scenario.collect.wait(), 2)
    async with AsyncClient(
        transport=ASGITransport(app=create_app(scan_service=manager)), base_url="http://test"
    ) as client:
        response = await client.delete(f"/api/scans/{created['id']}")
        snapshot = await client.get(f"/api/scans/{created['id']}")
    assert response.status_code == 500
    assert "secret" not in response.text + snapshot.text
    assert snapshot.json()["error_details"] == {
        "code": "cleanup_failed",
        "phase": "cleanup",
        "retryable": False,
        "message": "Mihomo 进程或工作目录清理未确认",
    }
    assert scenario.cores[0].work_dir.exists()
    assert not scenario.cores[0].stopped


@pytest.mark.asyncio
async def test_api_exposes_selector_errors_in_node_summaries(scenario):
    scenario.selected_name = "wrong-node"
    manager = scenario.manager
    created = manager.create("https://example.invalid/subscription")
    await asyncio.wait_for(manager.wait(created["id"]), 2)
    async with AsyncClient(
        transport=ASGITransport(app=create_app(scan_service=manager)), base_url="http://test"
    ) as client:
        response = await client.get(f"/api/scans/{created['id']}")
    assert response.status_code == 200
    job = response.json()
    assert job["status"] == "completed"
    assert len(job["results"]) == 3
    for result in job["results"]:
        assert result["error_details"] == {
            "code": "selector_unconfirmed",
            "phase": "select",
            "retryable": True,
            "message": "Mihomo selector 未确认所选节点",
        }


def test_structured_environment_error_does_not_echo_exception():
    error = classify_error(MihomoNotReadyError("https://private.invalid/?secret=token"))
    assert error.message == MIHOMO_NOT_READY_MESSAGE
    assert "secret" not in error.message
