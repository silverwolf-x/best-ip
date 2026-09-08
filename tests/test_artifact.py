import copy
import hashlib
import json
from pathlib import Path

import pytest

from backend.app.results.artifact import build_artifact
from backend.app.results.store import ResultStore
from backend.app.results.validation import ResultStoreError


@pytest.fixture
def exported(tmp_path):
    fixture = json.loads(
        (Path(__file__).parent / "fixtures/contracts/records.json").read_text(encoding="utf-8")
    )
    record = copy.deepcopy(fixture["base"])
    store = ResultStore(tmp_path)
    store.initialize(record["job_id"], {})
    store.write_node(record["job_id"], 0, record)
    store.finalize(record["job_id"], {"total": 1})
    return store.export(record["job_id"], {"cleanup_confirmed": True})


def test_artifact_builds_exact_v1_bytes(exported):
    result, status = build_artifact(exported, exported["id"], 42, 1, set())
    decoded = json.loads(status)
    assert json.loads(result) == exported
    assert decoded["result_sha256"] == hashlib.sha256(result).hexdigest()
    assert decoded["schema_version"] == 1
    assert decoded["sanitized"] is True
    assert decoded["counts"] == exported["manifest"]["counts"]
    assert decoded["usable"] is True
    assert result.endswith(bytes([10]))


@pytest.mark.parametrize(
    "field,value",
    [
        ("cleanup_confirmed", False),
        ("id", "other"),
        ("completed", 2),
        ("success_count", 9),
        ("manifest_ready", False),
        ("status", "failed"),
    ],
)
def test_artifact_rejects_invalid_completion(exported, field, value):
    request_id = exported["id"]
    exported[field] = value
    with pytest.raises(ResultStoreError):
        build_artifact(exported, request_id, 42, 1, set())


@pytest.mark.parametrize(
    "field,value",
    [
        ("index", 1),
        ("file", "../0000.json"),
        ("sha256", "0" * 64),
        ("bytes", 1),
        ("summary", {}),
    ],
)
def test_artifact_rejects_invalid_manifest(exported, field, value):
    exported["manifest"]["records"][0][field] = value
    with pytest.raises(ResultStoreError):
        build_artifact(exported, exported["id"], 42, 1, set())


@pytest.mark.parametrize(
    "message",
    [
        {"password": "secret-value"},
        "https://example.org/?token=secret-value",
        "contains secret-value here",
        "https://user:secret-value@example.org/",
    ],
)
def test_artifact_rejects_credentials(exported, message):
    exported["message"] = message
    with pytest.raises(ResultStoreError):
        build_artifact(exported, exported["id"], 42, 1, {"secret-value"})


@pytest.mark.parametrize("run_id,attempt", [(0, 1), (True, 1), (1, 0), (1, True)])
def test_artifact_rejects_invalid_run_identity(exported, run_id, attempt):
    with pytest.raises(ResultStoreError):
        build_artifact(exported, exported["id"], run_id, attempt, set())


@pytest.mark.parametrize("status", ["partial", "failed"])
def test_artifact_keeps_legacy_usable_false(exported, tmp_path, status):
    record = exported["results"][0]
    record["status"] = status
    record["completeness"]["complete"] = False
    if status == "failed":
        record["exit_ip"] = None
        record["error"] = "connection failed"
    store = ResultStore(tmp_path / "alternate")
    store.initialize(record["job_id"], {})
    store.write_node(record["job_id"], 0, record)
    store.finalize(record["job_id"], {"total": 1})
    exported = store.export(record["job_id"], {"cleanup_confirmed": True})
    _, status_bytes = build_artifact(exported, exported["id"], 42, 1, set())
    assert json.loads(status_bytes)["usable"] is False
    assert json.loads(status_bytes)["counts"][status] == 1


def test_artifact_rejects_unknown_url_credentials_without_subscription_context(exported):
    exported["message"] = "https://user:password@example.org/"
    with pytest.raises(ResultStoreError):
        build_artifact(exported, exported["id"], 42, 1, set())
