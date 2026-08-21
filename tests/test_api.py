from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.jobs import job_manager
from backend.app.main import app
from backend.app.mihomo import MIHOMO_NOT_READY_MESSAGE
from backend.app.result_store import result_store


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


def test_health_reports_application_and_core_state() -> None:
    with TestClient(app) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert isinstance(response.json()["mihomo_ready"], bool)


def test_scan_request_rejects_missing_mihomo_core(tmp_path, monkeypatch) -> None:
    request_id = "b" * 32
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


def test_scan_request_rejects_invalid_subscription_snapshot_hash() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/scans",
            json={
                "subscription_url": "https://example.com/subscription",
                "subscription_sha256": "not-a-sha256",
            },
        )
    assert response.status_code == 422


def test_scan_request_id_conflict_returns_409(tmp_path, monkeypatch) -> None:
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


def test_unknown_job_returns_not_found() -> None:
    with TestClient(app) as client:
        response = client.get("/api/scans/not-found")
    assert response.status_code == 404
    assert response.json()["detail"] == "扫描任务不存在"


def test_result_and_export_are_blocked_before_manifest(tmp_path, monkeypatch) -> None:
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


def test_completed_api_reads_manifest_and_node_store(tmp_path, monkeypatch) -> None:
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


def test_frontend_is_coffee_only_and_has_no_default_credential() -> None:
    with TestClient(app) as client:
        response = client.get("/")
        app_script = client.get("/app.js")
    assert response.status_code == app_script.status_code == 200
    assert "Coffee" in response.text
    assert "每个节点完成并原子暂存后会立即显示" in response.text
    assert "state.results = Array.isArray(job.results)" in app_script.text
    assert 'value="https://' not in response.text
    forbidden_terms = (
        "chatgpt.com",
        "claude.ai",
        "api.openai.com",
        "anthropic.com",
        "gpt_access",
        "claude_access",
    )
    for forbidden in forbidden_terms:
        assert forbidden not in response.text
    assert "manifest" in response.text
    assert 'data-sort="score"' in response.text
