from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.main import create_app
from backend.app.mihomo import MIHOMO_NOT_READY_MESSAGE
from backend.app.results.store import ResultStore
from backend.app.scan.jobs import ScanJobManager


@pytest.fixture
def result_store(tmp_path):
    return ResultStore(tmp_path / "results")


@pytest.fixture
def job_manager(tmp_path, result_store):
    return ScanJobManager(Settings(), result_store, tmp_path / "jobs")


@pytest.fixture
def app(job_manager):
    return create_app(scan_service=job_manager)


def _record(job_id: str, index: int) -> dict:
    return {
        "schema_version": 1,
        "job_id": job_id,
        "node_index": index,
        "node": f"node-{index}",
        "type": "ss",
        "status": "failed",
        "selected_proxy": None,
        "exit_ip": None,
        "error": "failed",
        "transport_error": "failed",
        "started_at": "now",
        "finished_at": "later",
        "elapsed_ms": 1,
        "completeness": {"complete": False},
        "proxy_evidence": {},
        "requests": {},
        "coffee": {},
    }


def test_health_reports_application_and_core_state(app) -> None:
    with TestClient(app) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["mode"] == "runner-api"
    assert isinstance(response.json()["mihomo_ready"], bool)


def test_scan_request_rejects_missing_mihomo_core(app, job_manager, tmp_path, monkeypatch) -> None:
    request_id = "req-" + "b" * 32
    monkeypatch.setattr(
        job_manager,
        "settings",
        Settings(mihomo_path=tmp_path / "missing-mihomo.exe"),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/scans",
            json={
                "subscription_url": "https://example.com/subscription",
                "request_id": request_id,
            },
        )

    assert response.status_code == 503
    assert response.json()["detail"] == MIHOMO_NOT_READY_MESSAGE
    assert request_id not in job_manager.jobs


def test_scan_request_rejects_invalid_subscription_snapshot_hash(app) -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/scans",
            json={
                "subscription_url": "https://example.com/subscription",
                "subscription_sha256": "not-a-sha256",
            },
        )
    assert response.status_code == 422


def test_scan_request_id_conflict_returns_409(app, job_manager, tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        job_manager,
        "settings",
        Settings(mihomo_path=tmp_path / "missing-mihomo.exe"),
    )
    request_id = "a" * 32
    job_manager.jobs[request_id] = {"id": request_id, "status": "queued"}
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/scans",
                json={
                    "subscription_url": "https://example.com/subscription",
                    "request_id": request_id,
                },
            )
        assert response.status_code == 409
    finally:
        job_manager.jobs.pop(request_id, None)


def test_unknown_job_returns_not_found(app) -> None:
    with TestClient(app) as client:
        response = client.get("/api/scans/not-found")
    assert response.status_code == 404
    assert response.json()["detail"] == "扫描任务不存在"


def test_result_and_export_are_blocked_before_manifest(
    app, job_manager, result_store, tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(result_store, "root", tmp_path / "results")
    job_id = "api-running"
    job_manager.jobs[job_id] = {
        "id": job_id,
        "status": "running",
        "manifest_ready": False,
        "total": 2,
        "completed": 1,
        "results": [],
    }
    result_store.initialize(job_id, {"job_id": job_id, "status": "running"})
    result_store.write_node(job_id, 1, _record(job_id, 1))
    try:
        with TestClient(app) as client:
            assert client.get(f"/api/scans/{job_id}/results/1").status_code == 409
            assert client.get(f"/api/scans/{job_id}/export").status_code == 409
            job = client.get(f"/api/scans/{job_id}").json()
        assert [result["node_index"] for result in job["results"]] == [1]
    finally:
        job_manager.jobs.pop(job_id, None)


def test_completed_api_reads_manifest_and_node_store(
    app, job_manager, result_store, tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(result_store, "root", tmp_path / "results")
    job_id = "api-completed"
    job = {
        "id": job_id,
        "status": "completed",
        "manifest_ready": True,
        "created_at": "now",
        "finished_at": "later",
        "total": 1,
        "skipped": 0,
        "completed": 1,
        "success_count": 0,
        "partial_count": 0,
        "failed_count": 1,
        "execution_mode": "sequential",
    }
    result_store.initialize(job_id, {"job_id": job_id, "status": "completed"})
    result_store.write_node(job_id, 0, _record(job_id, 0))
    result_store.finalize(job_id, job)
    job_manager.jobs[job_id] = job
    try:
        with TestClient(app) as client:
            summary = client.get(f"/api/scans/{job_id}")
            detail = client.get(f"/api/scans/{job_id}/results/0")
            exported = client.get(f"/api/scans/{job_id}/export")
        assert summary.status_code == detail.status_code == exported.status_code == 200
        assert summary.json()["results"][0]["node_index"] == 0
        assert detail.json()["exit_ip"] is None
        assert exported.json()["manifest"]["complete"] is True
    finally:
        job_manager.jobs.pop(job_id, None)


def test_actions_api_does_not_serve_a_second_frontend(app) -> None:
    with TestClient(app) as client:
        response = client.get("/")
        app_script = client.get("/app.js")
    assert response.status_code == app_script.status_code == 404


def test_local_dev_app_only_serves_api() -> None:
    with TestClient(create_app(local_dev=True)) as client:
        page = client.get("/")
        app_script = client.get("/app.js")
        site_config = client.get("/site-config.js")
        health = client.get("/api/health")

    assert page.status_code == app_script.status_code == site_config.status_code == 404
    assert health.json()["mode"] == "local"
    assert isinstance(health.json()["mihomo_ready"], bool)


def test_local_dev_cors_allows_only_configured_frontend_origin() -> None:
    frontend_origin = "http://127.0.0.1:5173"
    with TestClient(create_app(local_dev=True, local_frontend_origin=frontend_origin)) as client:
        allowed = client.options(
            "/api/scans",
            headers={
                "Origin": frontend_origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        rejected = client.options(
            "/api/scans",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == frontend_origin
    assert "POST" in allowed.headers["access-control-allow-methods"]
    assert "content-type" in allowed.headers["access-control-allow-headers"].lower()
    assert "access-control-allow-origin" not in rejected.headers


def test_validation_error_does_not_echo_subscription_secret() -> None:
    secret = "sensitive-subscription-token"
    with TestClient(create_app(local_dev=True)) as client:
        response = client.post(
            "/api/scans",
            json={"subscription_url": f"https://example.com/?token={secret}" + "x" * 5000},
        )

    assert response.status_code == 422
    assert response.json() == {"detail": "请求参数无效"}
    assert secret not in response.text


def test_application_instances_isolate_configuration_and_jobs(tmp_path) -> None:
    first = create_app(
        app_settings=Settings(mihomo_path=tmp_path / "missing"),
        result_store=ResultStore(tmp_path / "first-results"),
        workspace=tmp_path / "first-jobs",
        local_dev=True,
    )
    second = create_app(
        app_settings=Settings(mihomo_path=Path(__file__)),
        result_store=ResultStore(tmp_path / "second-results"),
        workspace=tmp_path / "second-jobs",
        local_dev=False,
    )
    first.state.scan_service.jobs["private-job"] = {
        "id": "private-job",
        "status": "cancelled",
        "cleanup_confirmed": True,
    }
    with TestClient(first) as first_client, TestClient(second) as second_client:
        assert first_client.get("/api/health").json()["mihomo_ready"] is False
        assert second_client.get("/api/health").json()["mihomo_ready"] is True
        assert first_client.get("/api/scans/private-job").status_code == 200
        assert second_client.get("/api/scans/private-job").status_code == 404
        assert first_client.get("/api/health").json()["mode"] == "local"
        assert second_client.get("/api/health").json()["mode"] == "runner-api"
    assert first.state.scan_service.result_store.root != second.state.scan_service.result_store.root
    assert first.state.scan_service.workspace != second.state.scan_service.workspace
