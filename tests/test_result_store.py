from __future__ import annotations

import json

import pytest

from backend.app.result_store import ResultStore, ResultStoreError


def make_record(job_id: str, index: int, *, status: str = "failed", exit_ip=None) -> dict:
    return {
        "schema_version": 1,
        "job_id": job_id,
        "node_index": index,
        "node": f"node-{index}",
        "type": "ss",
        "status": status,
        "selected_proxy": f"node-{index}" if status != "failed" else None,
        "exit_ip": exit_ip,
        "error": None if status != "failed" else "connection failed",
        "transport_error": None,
        "started_at": "now",
        "finished_at": "later",
        "elapsed_ms": 1,
        "completeness": {
            "complete": status != "failed",
            "checks": {
                "page_received": status != "failed",
                "trace_received": status != "failed",
                "exit_ip_valid": status != "failed",
                "lookup_received": status != "failed",
                "lookup_matches_trace": status != "failed",
            },
        },
        "proxy_evidence": {
            "transport": "workspace_mihomo_mixed_port",
            "proxy_url": "http://127.0.0.1:12345",
            "mihomo_instance": "instance-a",
            "target_origin": "https://ip.net.coffee",
            "selected_proxy": f"node-{index}" if status != "failed" else None,
            "selection_confirmed": status != "failed",
            "trust_env": False,
            "direct_fallback": False,
        },
        "requests": {},
        "coffee": {},
    }


def test_result_store_writes_nodes_atomically_and_finalizes_manifest(tmp_path) -> None:
    store = ResultStore(tmp_path / "results")
    job_id = "job-1"
    job = {"id": job_id, "total": 2, "skipped": 1, "created_at": "now", "finished_at": "later"}
    store.initialize(job_id, {"job_id": job_id, "status": "running", "results": []})
    store.write_node(job_id, 0, make_record(job_id, 0, status="success", exit_ip="203.0.113.10"))
    store.write_node(job_id, 1, make_record(job_id, 1))

    manifest = store.finalize(job_id, job)
    assert manifest["complete"] is True
    assert manifest["total"] == 2
    assert [item["index"] for item in manifest["records"]] == [0, 1]
    assert all(len(item["sha256"]) == 64 for item in manifest["records"])
    assert store.read_manifest(job_id)["counts"]["failed"] == 1
    assert store.read_node(job_id, 0)["exit_ip"] == "203.0.113.10"


def test_result_store_reads_available_summaries_before_manifest(tmp_path) -> None:
    store = ResultStore(tmp_path / "results")
    job_id = "job-live"
    store.initialize(job_id, {"job_id": job_id, "status": "running"})
    store.write_node(job_id, 1, make_record(job_id, 1))

    summaries = store.read_available_summaries(job_id, expected_count=1)

    assert [summary["node_index"] for summary in summaries] == [1]
    with pytest.raises(ResultStoreError, match="manifest"):
        store.read_summaries(job_id)

    store.write_node(
        job_id,
        0,
        make_record(job_id, 0, status="success", exit_ip="203.0.113.10"),
    )
    summaries = store.read_available_summaries(job_id, expected_count=2)
    assert [summary["node_index"] for summary in summaries] == [0, 1]


def test_result_store_rejects_duplicate_or_incomplete_nodes(tmp_path) -> None:
    store = ResultStore(tmp_path / "results")
    job_id = "job-2"
    store.initialize(job_id, {"job_id": job_id})
    record = make_record(job_id, 0)
    store.write_node(job_id, 0, record)
    with pytest.raises(ResultStoreError, match="已写入"):
        store.write_node(job_id, 0, record)
    with pytest.raises(ResultStoreError, match="不完整"):
        store.finalize(job_id, {"id": job_id, "total": 2})


def test_result_store_rejects_failed_exit_ip_and_tampered_manifest(tmp_path) -> None:
    store = ResultStore(tmp_path / "results")
    job_id = "job-3"
    store.initialize(job_id, {"job_id": job_id})
    bad = make_record(job_id, 0, status="failed", exit_ip="203.0.113.10")
    with pytest.raises(ResultStoreError, match="失败节点"):
        store.write_node(job_id, 0, bad)

    store.write_node(job_id, 0, make_record(job_id, 0))
    store.finalize(job_id, {"id": job_id, "total": 1})
    node_path = tmp_path / "results" / job_id / "nodes" / "0000.json"
    node_payload = json.loads(node_path.read_text(encoding="utf-8"))
    node_payload["error"] = "tampered"
    node_path.write_text(json.dumps(node_payload), encoding="utf-8")
    with pytest.raises(ResultStoreError, match="hash/size"):
        store.read_manifest(job_id)


def test_result_store_rejects_incomplete_proxy_evidence(tmp_path) -> None:
    store = ResultStore(tmp_path / "results")
    job_id = "job-evidence"
    store.initialize(job_id, {"job_id": job_id})
    record = make_record(
        job_id,
        0,
        status="success",
        exit_ip="203.0.113.10",
    )
    record["proxy_evidence"].pop("transport")

    with pytest.raises(ResultStoreError, match="代理证据"):
        store.write_node(job_id, 0, record)


def test_result_store_rejects_unknown_sensitive_node_fields(tmp_path) -> None:
    store = ResultStore(tmp_path / "results")
    job_id = "job-sensitive"
    store.initialize(job_id, {"job_id": job_id})
    record = make_record(job_id, 0)
    record["token"] = "secret-value"

    with pytest.raises(ResultStoreError, match="字段集合"):
        store.write_node(job_id, 0, record)


def test_result_store_rejects_tampered_manifest_completion_fields(tmp_path) -> None:
    store = ResultStore(tmp_path / "results")
    job_id = "job-manifest"
    store.initialize(job_id, {"job_id": job_id})
    store.write_node(job_id, 0, make_record(job_id, 0))
    store.finalize(job_id, {"id": job_id, "total": 1})
    manifest_path = tmp_path / "results" / job_id / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["completed"] = 0
    manifest["all_records_present"] = False
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ResultStoreError, match="结构或任务绑定"):
        store.read_manifest(job_id)


def test_result_store_export_uses_manifest_completion_facts(tmp_path) -> None:
    store = ResultStore(tmp_path / "results")
    job_id = "job-export"
    store.initialize(job_id, {"job_id": job_id})
    store.write_node(job_id, 0, make_record(job_id, 0))
    store.finalize(job_id, {"id": job_id, "total": 1})

    exported = store.export(
        job_id,
        {
            "id": job_id,
            "status": "completed",
            "total": 999,
            "success_count": 999,
            "subscription_url": "https://example.com/?token=secret-value",
        },
    )

    assert exported["total"] == 1
    assert exported["completed"] == 1
    assert exported["success_count"] == 0
    assert "subscription_url" not in exported


def test_result_store_rejects_path_traversal_job_id(tmp_path) -> None:
    store = ResultStore(tmp_path / "results")
    with pytest.raises(ResultStoreError):
        store.initialize("../outside", {})
