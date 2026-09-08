import copy
import json
from pathlib import Path

import pytest
import yaml

from backend.app.results.store import ResultStore, ResultStoreError

FIXTURES = Path(__file__).parent / "fixtures" / "contracts"
RECORDS = json.loads((FIXTURES / "records.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", RECORDS["cases"], ids=lambda case: case["name"])
def test_shared_node_contract(case, tmp_path):
    record = copy.deepcopy(RECORDS["base"])
    record.update(case["patch"])
    store = ResultStore(tmp_path)
    job_id = RECORDS["identity"]["requestId"]
    store.initialize(job_id, {"status": "running"})
    if not case["python_valid"]:
        with pytest.raises(ResultStoreError):
            store.write_node(job_id, 0, record)
        return
    store.write_node(job_id, 0, record)
    store.finalize(job_id, {"total": 1})
    exported = store.export(job_id, {"cleanup_confirmed": True})
    assert exported["results"] == [record]
    assert exported["manifest"]["counts"][record["status"]] == 1


@pytest.mark.parametrize("name", ["environment_failure", "cancelled"])
def test_noncompleted_lifecycle_has_no_export(name, tmp_path):
    lifecycle = json.loads((FIXTURES / "lifecycle.json").read_text(encoding="utf-8"))[name]
    store = ResultStore(tmp_path)
    store.initialize(lifecycle["id"], lifecycle)
    assert store.read_progress(lifecycle["id"])["status"] == lifecycle["status"]
    with pytest.raises(ResultStoreError):
        store.export(lifecycle["id"], lifecycle)


def test_workflow_dispatch_contract():
    workflow = yaml.safe_load(Path(".github/workflows/scan.yml").read_text(encoding="utf-8"))
    dispatch = workflow.get("on", workflow.get(True))["workflow_dispatch"]
    assert set(dispatch["inputs"]) == {"request_id", "key_id", "encrypted_subscription_url"}
    assert all(
        value["required"] and value["type"] == "string"
        for value in dispatch["inputs"].values()
    )
    assert workflow["run-name"] == "Best IP scan ${{ inputs.request_id }}"
    upload = next(
        step for step in workflow["jobs"]["scan"]["steps"]
        if step.get("uses", "").startswith("actions/upload-artifact@")
    )
    assert upload["with"]["name"] == (
        "best-ip-result-${{ inputs.request_id }}-"
        "${{ github.run_id }}-${{ github.run_attempt }}"
    )
    assert upload["with"]["retention-days"] == 1


def test_corrupt_manifest_digest_is_rejected(tmp_path):
    store = ResultStore(tmp_path)
    record = copy.deepcopy(RECORDS["base"])
    job_id = record["job_id"]
    store.initialize(job_id, {"status": "running"})
    store.write_node(job_id, 0, record)
    manifest = store.finalize(job_id, {"total": 1})
    invalid = json.loads((FIXTURES / "lifecycle.json").read_text(encoding="utf-8"))
    manifest["records"][0]["sha256"] = invalid["invalid_artifact"]["value"]
    (tmp_path / job_id / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ResultStoreError, match="hash/size"):
        store.export(job_id, {"cleanup_confirmed": True})
