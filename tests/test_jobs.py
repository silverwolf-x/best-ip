from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from backend.app.config import Settings
from backend.app.jobs import (
    ScanJobManager,
    _attach_mihomo_error,
    _failed_node,
    _safe_job_error,
    _summarize_mihomo_error,
)
from backend.app.mihomo import (
    MIHOMO_NOT_READY_MESSAGE,
    MihomoError,
    MihomoNotReadyError,
)
from backend.app.result_store import result_store


class FakeMihomo:
    def __init__(self, message: str = "", *, read_error: Exception | None = None) -> None:
        self.message = message
        self.read_error = read_error

    def read_log_since(self, _offset: int) -> str:
        if self.read_error:
            raise self.read_error
        return self.message


def _collector_result(error_type: str) -> dict:
    return {
        "status": "failed",
        "error": error_type,
        "transport_error": None,
        "requests": {"trace": {"error_type": error_type}},
        "pages": {"ip": {"error": error_type}},
    }


def test_attach_mihomo_error_uses_safe_summary() -> None:
    result = _collector_result("ConnectError")
    mihomo = FakeMihomo(
        'node.example:443 connect error: dns resolve failed: credential="secret"'
    )

    _attach_mihomo_error(result, mihomo, 0)  # type: ignore[arg-type]

    assert result["transport_error"] == "节点服务器域名无法解析"
    assert result["error"] == "ConnectError；节点服务器域名无法解析"
    assert result["pages"]["ip"]["error"] == result["error"]
    assert "node.example" not in str(result)
    assert "secret" not in str(result)


def test_attach_mihomo_error_ignores_non_transport_failure() -> None:
    result = _collector_result("ResponseParseError")

    _attach_mihomo_error(  # type: ignore[arg-type]
        result,
        FakeMihomo("connection refused"),
        0,
    )

    assert result["transport_error"] is None
    assert result["error"] == "ResponseParseError"


def test_attach_mihomo_error_survives_unreadable_log() -> None:
    result = _collector_result("ConnectError")

    _attach_mihomo_error(  # type: ignore[arg-type]
        result,
        FakeMihomo(read_error=OSError("secret path")),
        0,
    )

    assert result["transport_error"] == "节点传输连接失败"
    assert "secret path" not in str(result)


def test_failed_node_does_not_persist_raw_mihomo_error() -> None:
    result = _failed_node(
        "job",
        0,
        "node-a",
        "vless",
        MihomoError('startup failed: endpoint.example credential="secret"'),
    )

    assert result["error"] == "Mihomo 节点连接失败"
    assert result["transport_error"] == result["error"]
    assert "endpoint.example" not in str(result)
    assert "secret" not in str(result)


def test_summarize_mihomo_error_covers_observed_failures() -> None:
    assert _summarize_mihomo_error("dns resolve failed") == "节点服务器域名无法解析"
    assert _summarize_mihomo_error("reality authentication failed") == "节点 REALITY 认证失败"
    assert _summarize_mihomo_error("context deadline exceeded") == "连接节点服务器超时"
    assert _summarize_mihomo_error("connect error: EOF") == "节点服务器提前断开连接"
    assert _summarize_mihomo_error("TLS handshake timeout") == "节点 TLS 握手失败"
    assert _summarize_mihomo_error("connection reset by peer") == "节点服务器重置连接"


def test_job_error_preserves_safe_missing_core_action() -> None:
    error = _safe_job_error(MihomoNotReadyError(MIHOMO_NOT_READY_MESSAGE))

    assert error == MIHOMO_NOT_READY_MESSAGE


def test_job_error_does_not_persist_unexpected_exception_text() -> None:
    error = _safe_job_error(
        RuntimeError("https://subscription.example/?token=secret-value")
    )

    assert error == "扫描任务失败（RuntimeError）"
    assert "secret-value" not in error


@pytest.mark.asyncio
async def test_job_rejects_subscription_snapshot_mismatch(tmp_path, monkeypatch) -> None:
    content = b"proxies:\n  - {name: node-a, type: ss}"

    async def fake_download(
        _url: str,
        *,
        max_bytes: int,
        timeout_seconds: float,
    ) -> bytes:
        assert max_bytes > 0
        assert timeout_seconds > 0
        return content

    monkeypatch.setattr("backend.app.jobs.download_subscription", fake_download)
    monkeypatch.setattr("backend.app.jobs.JOBS_DIR", tmp_path / "jobs")
    manager = ScanJobManager(Settings(mihomo_path=Path(__file__)))

    created = manager.create(
        "https://subscription.example/?token=secret-value",
        subscription_sha256="0" * 64,
    )
    await manager.tasks[created["id"]]
    job = manager.get(created["id"])

    assert job["status"] == "failed"
    assert job["error"] == "订阅内容与请求快照不一致"
    assert "secret-value" not in str(job)


@pytest.mark.asyncio
async def test_job_fails_as_infrastructure_error_when_core_is_missing(
    tmp_path,
    monkeypatch,
) -> None:
    content = b"proxies:\n  - {name: node-a, type: ss}"

    async def fake_download(
        _url: str,
        *,
        max_bytes: int,
        timeout_seconds: float,
    ) -> bytes:
        assert max_bytes > 0
        assert timeout_seconds > 0
        return content

    monkeypatch.setattr("backend.app.jobs.download_subscription", fake_download)
    monkeypatch.setattr("backend.app.jobs.JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(result_store, "root", tmp_path / "results")
    core_path = tmp_path / "mihomo.exe"
    core_path.write_bytes(b"")
    manager = ScanJobManager(Settings(mihomo_path=core_path))

    created = manager.create("https://subscription.example/subscription")
    core_path.unlink()
    await manager.tasks[created["id"]]
    job = manager.get(created["id"])

    assert job["status"] == "failed"
    assert job["error"] == MIHOMO_NOT_READY_MESSAGE
    assert job["completed"] == 0
    assert job["manifest_ready"] is False
    assert job["cleanup_confirmed"] is True
    nodes_dir = tmp_path / "results" / created["id"] / "nodes"
    assert list(nodes_dir.glob("*.json")) == []


@pytest.mark.asyncio
async def test_cancel_marks_never_started_job_cancelled() -> None:
    manager = ScanJobManager(Settings(mihomo_path=Path(__file__)))
    created = manager.create("https://subscription.example/subscription")

    job = await manager.cancel(created["id"])

    assert job["status"] == "cancelled"
    assert job["cleanup_confirmed"] is True
    assert job["finished_at"] is not None


@pytest.mark.asyncio
async def test_shutdown_marks_never_started_job_cancelled() -> None:
    manager = ScanJobManager(Settings(mihomo_path=Path(__file__)))
    created = manager.create("https://subscription.example/subscription")

    await manager.shutdown()

    job = manager.get(created["id"])
    assert job["status"] == "cancelled"
    assert job["cleanup_confirmed"] is True
    assert job["finished_at"] is not None


@pytest.mark.asyncio
async def test_scan_node_retries_with_fresh_mihomo_processes(
    tmp_path,
    monkeypatch,
) -> None:
    instances: list[Any] = []
    written: dict[str, Any] = {}
    collector_calls = 0

    class RetryMihomo:
        group_name = "BEST-IP"

        def __init__(
            self,
            _core_path: Path,
            work_dir: Path,
            _proxies: list[dict[str, Any]],
            *,
            selector_names: list[str],
            outbound_interface: str | None,
            dns_bootstrap_proxy: str | None,
        ) -> None:
            self.work_dir = work_dir
            self.outbound_interface = outbound_interface
            self.dns_bootstrap_proxy = dns_bootstrap_proxy
            self.instance_id = f"instance-{len(instances) + 1}"
            self.proxy_url = f"http://127.0.0.1:{21000 + len(instances)}"
            self.stopped = False
            assert selector_names == ["node-a"]
            instances.append(self)

        async def start(self) -> None:
            self.work_dir.mkdir(parents=True)

        def log_offset(self) -> int:
            return 0

        async def select(self, node_name: str) -> str:
            return node_name

        def read_log_since(self, _offset: int) -> str:
            return "connect error: i/o timeout"

        async def stop(self) -> None:
            self.stopped = True

    class RetryCollector:
        def __init__(self, proxy_url: str, *, timeout_ms: int) -> None:
            assert proxy_url.startswith("http://127.0.0.1:")
            assert timeout_ms > 0

        async def collect(self, **kwargs: Any) -> dict[str, Any]:
            nonlocal collector_calls
            collector_calls += 1
            if collector_calls < 3:
                return {
                    "status": "failed",
                    "error": "ConnectError",
                    "transport_error": None,
                    "requests": {"trace": {"error_type": "ConnectError"}},
                    "pages": {"ip": {"error": "ConnectError"}},
                    "proxy_evidence": {
                        "mihomo_instance": kwargs["mihomo_instance"],
                    },
                }
            return {
                "status": "success",
                "error": None,
                "transport_error": None,
                "requests": {},
                "pages": {"ip": {"error": None}},
                "proxy_evidence": {
                    "mihomo_instance": kwargs["mihomo_instance"],
                },
            }

    def capture_node(_job_id: str, _index: int, result: dict[str, Any]) -> None:
        written["result"] = result

    async def ignore_progress(_job: dict[str, Any]) -> None:
        return None

    monkeypatch.setattr("backend.app.jobs.MihomoProcess", RetryMihomo)
    monkeypatch.setattr("backend.app.jobs.CoffeeCollector", RetryCollector)
    monkeypatch.setattr(result_store, "write_node", capture_node)
    manager = ScanJobManager(
        Settings(
            mihomo_path=tmp_path / "mihomo.exe",
            max_parallel_nodes=1,
            max_node_attempts=3,
            node_retry_backoff_ms=0,
        )
    )
    monkeypatch.setattr(manager, "_write_progress", ignore_progress)
    job = {
        "id": "job-a",
        "total": 1,
        "completed": 0,
        "success_count": 0,
        "partial_count": 0,
        "failed_count": 0,
    }

    await manager._scan_node(
        job,
        tmp_path / "job-work",
        [{"name": "node-a", "type": "ss"}],
        {"name": "node-a", "type": "ss"},
        0,
        ["bootstrap-a", "bootstrap-b", "bootstrap-c"],
        "WLAN",
        asyncio.Semaphore(1),
    )

    result = written["result"]
    assert collector_calls == 3
    assert [instance.instance_id for instance in instances] == [
        "instance-1",
        "instance-2",
        "instance-3",
    ]
    assert [instance.dns_bootstrap_proxy for instance in instances] == [
        "bootstrap-a",
        "bootstrap-b",
        "bootstrap-c",
    ]
    assert all(instance.stopped for instance in instances)
    assert all(not instance.work_dir.exists() for instance in instances)
    assert result["status"] == "success"
    assert result["attempt_count"] == 3
    assert result["retry_count"] == 2
    assert result["attempt_errors"] == [
        "连接节点服务器超时",
        "连接节点服务器超时",
    ]
    assert result["proxy_evidence"]["outbound_interface"] == "WLAN"
    assert result["proxy_evidence"]["dns_bootstrap_proxy"] == "bootstrap-c"
    assert result["proxy_evidence"]["fresh_mihomo_per_attempt"] is True
    assert result["proxy_evidence"]["max_attempts"] == 3
    assert job["completed"] == 1
    assert job["success_count"] == 1
