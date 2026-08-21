from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.config import Settings
from backend.app.jobs import (
    ScanJobManager,
    _attach_mihomo_error,
    _failed_node,
    _safe_job_error,
    _summarize_mihomo_error,
)
from backend.app.mihomo import MihomoError


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
    manager = ScanJobManager(Settings(mihomo_path=Path("mihomo.exe")))

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
async def test_cancel_marks_never_started_job_cancelled() -> None:
    manager = ScanJobManager(Settings(mihomo_path=Path("mihomo.exe")))
    created = manager.create("https://subscription.example/subscription")

    job = await manager.cancel(created["id"])

    assert job["status"] == "cancelled"
    assert job["cleanup_confirmed"] is True
    assert job["finished_at"] is not None


@pytest.mark.asyncio
async def test_shutdown_marks_never_started_job_cancelled() -> None:
    manager = ScanJobManager(Settings(mihomo_path=Path("mihomo.exe")))
    created = manager.create("https://subscription.example/subscription")

    await manager.shutdown()

    job = manager.get(created["id"])
    assert job["status"] == "cancelled"
    assert job["cleanup_confirmed"] is True
    assert job["finished_at"] is not None
