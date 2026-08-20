from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.main import app


def test_health_reports_application_and_core_state() -> None:
    with TestClient(app) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "mihomo_ready": True}


def test_unknown_job_returns_not_found() -> None:
    with TestClient(app) as client:
        response = client.get("/api/scans/not-found")

    assert response.status_code == 404
    assert response.json()["detail"] == "扫描任务不存在"


def test_frontend_is_served() -> None:
    with TestClient(app) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "Best IP" in response.text
    assert response.text.count('data-sort="score"') == 1
    assert "IP 评分" in response.text
    assert "AI 接入与延迟" in response.text
    assert "Coffee 全球 8 地 Ping" in response.text
    assert 'value="https://sub.nekocloud.host/nekocloud/token=/' in response.text
    assert 'data-sort="ip_score"' not in response.text
    assert 'data-sort="gpt_score"' not in response.text
    assert 'data-sort="claude_score"' not in response.text
    assert "综合评分" not in response.text
    assert "ChatGPT 质量" not in response.text
    assert "Claude 质量" not in response.text
