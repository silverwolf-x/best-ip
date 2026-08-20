from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

from .config import RESULTS_DIR

_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SUMMARY_KEYS = (
    "node_index",
    "node",
    "type",
    "selected_proxy",
    "status",
    "error",
    "transport_error",
    "exit_ip",
    "cidr",
    "rdns",
    "ai_verdict",
    "location",
    "score",
    "is_residential",
    "is_datacenter",
    "is_native",
    "traffic_profile",
    "company_type",
    "is_vpn",
    "is_proxy",
    "is_tor",
    "is_crawler",
    "is_abuser",
    "security_status",
    "asn",
    "as_org",
    "global_ping",
    "port_scan",
    "ping_check",
    "related_domains",
    "elapsed_ms",
    "started_at",
    "finished_at",
    "completeness",
    "proxy_evidence",
)


class ResultStoreError(RuntimeError):
    pass


class ResultStore:
    def __init__(self, root: Path = RESULTS_DIR) -> None:
        self.root = root

    def initialize(self, job_id: str, progress: dict[str, Any]) -> None:
        job_dir = self._job_dir(job_id)
        try:
            (job_dir / "nodes").mkdir(parents=True, exist_ok=False)
        except FileExistsError as exc:
            raise ResultStoreError(f"结果目录已存在：{job_id}") from exc
        self.write_progress(job_id, progress)

    def write_progress(self, job_id: str, progress: dict[str, Any]) -> None:
        payload = {
            key: value
            for key, value in progress.items()
            if key not in {"results", "subscription_url"}
        }
        self._atomic_write(self._job_dir(job_id) / "progress.json", payload)

    def write_node(self, job_id: str, index: int, record: dict[str, Any]) -> str:
        if index < 0:
            raise ResultStoreError("节点索引不能为负数")
        if record.get("job_id") != job_id or record.get("node_index") != index:
            raise ResultStoreError("节点记录与任务或索引不匹配")
        status = record.get("status")
        if status in {"success", "partial"}:
            if record.get("selected_proxy") != record.get("node"):
                raise ResultStoreError("节点记录的 selector 确认值不匹配")
            self._validate_exit_ip(record.get("exit_ip"))
        elif status == "failed":
            if record.get("exit_ip") is not None:
                raise ResultStoreError("失败节点不能保存伪造的出口 IP")
        else:
            raise ResultStoreError("节点记录状态无效")
        filename = self._node_filename(index)
        path = self._job_dir(job_id) / "nodes" / filename
        if path.exists():
            raise ResultStoreError(f"节点索引已写入：{index}")
        self._atomic_write(path, record)
        return filename

    def finalize(self, job_id: str, job: dict[str, Any]) -> dict[str, Any]:
        expected_total = job.get("total")
        if not isinstance(expected_total, int) or expected_total < 1:
            raise ResultStoreError("完成 manifest 前必须有合法节点总数")

        try:
            records = [self.read_node(job_id, index) for index in range(expected_total)]
        except ResultStoreError as exc:
            raise ResultStoreError(
                f"节点暂存文件不完整：期望 {expected_total} 个连续节点"
            ) from exc
        files = sorted((self._job_dir(job_id) / "nodes").glob("*.json"))
        if len(files) != expected_total:
            raise ResultStoreError(
                f"节点暂存文件不完整：期望 {expected_total}，实际 {len(files)}"
            )

        entries = []
        success = partial = failed = complete = 0
        for index, record in enumerate(records):
            if record.get("node_index") != index or record.get("job_id") != job_id:
                raise ResultStoreError(f"节点 {index} 暂存记录身份不匹配")
            status = record.get("status")
            if status == "success":
                self._validate_exit_ip(record.get("exit_ip"))
                success += 1
            elif status == "partial":
                self._validate_exit_ip(record.get("exit_ip"))
                partial += 1
            elif status == "failed":
                if record.get("exit_ip") is not None:
                    raise ResultStoreError(f"失败节点 {index} 含有出口 IP")
                failed += 1
            else:
                raise ResultStoreError(f"节点 {index} 状态无效")
            if (record.get("completeness") or {}).get("complete") is True:
                complete += 1
            path = self._job_dir(job_id) / "nodes" / self._node_filename(index)
            raw = path.read_bytes()
            entries.append(
                {
                    "index": index,
                    "file": self._node_filename(index),
                    "bytes": len(raw),
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "summary": self._summary(record),
                }
            )

        manifest = {
            "schema_version": 1,
            "job_id": job_id,
            "status": "completed",
            "created_at": job.get("created_at"),
            "finished_at": job.get("finished_at"),
            "total": expected_total,
            "skipped": job.get("skipped", 0),
            "completed": expected_total,
            "all_records_present": True,
            "complete": True,
            "execution_mode": job.get("execution_mode", "sequential"),
            "counts": {
                "success": success,
                "partial": partial,
                "failed": failed,
                "complete": complete,
            },
            "records": entries,
        }
        self._atomic_write(self._job_dir(job_id) / "manifest.json", manifest)
        return manifest

    def read_progress(self, job_id: str) -> dict[str, Any]:
        return self._read_json(self._job_dir(job_id) / "progress.json")

    def read_manifest(self, job_id: str) -> dict[str, Any]:
        manifest = self._read_json(self._job_dir(job_id) / "manifest.json")
        self._validate_manifest(job_id, manifest)
        return manifest

    def _validate_manifest(self, job_id: str, manifest: dict[str, Any]) -> None:
        total = manifest.get("total")
        records = manifest.get("records")
        if (
            manifest.get("schema_version") != 1
            or manifest.get("job_id") != job_id
            or manifest.get("status") != "completed"
            or manifest.get("complete") is not True
            or not isinstance(total, int)
            or total < 1
            or not isinstance(records, list)
            or len(records) != total
        ):
            raise ResultStoreError("manifest 结构或任务绑定无效")
        node_dir = self._job_dir(job_id) / "nodes"
        expected_files = {self._node_filename(index) for index in range(total)}
        actual_files = {path.name for path in node_dir.glob("*.json")}
        if actual_files != expected_files:
            raise ResultStoreError("manifest 节点文件集合不完整或含额外文件")
        counts = {"success": 0, "partial": 0, "failed": 0, "complete": 0}
        for expected_index, entry in enumerate(records):
            if not isinstance(entry, dict):
                raise ResultStoreError("manifest 节点条目无效")
            filename = self._node_filename(expected_index)
            if entry.get("index") != expected_index or entry.get("file") != filename:
                raise ResultStoreError("manifest 节点索引或文件名不连续")
            path = node_dir / filename
            raw = path.read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            if entry.get("bytes") != len(raw) or entry.get("sha256") != digest:
                raise ResultStoreError(f"节点 {expected_index} hash/size 校验失败")
            record = self.read_node(job_id, expected_index)
            if entry.get("summary") != self._summary(record):
                raise ResultStoreError(f"节点 {expected_index} 摘要与文件不一致")
            status = record.get("status")
            if status not in {"success", "partial", "failed"}:
                raise ResultStoreError(f"节点 {expected_index} 状态无效")
            counts[status] += 1
            if (record.get("completeness") or {}).get("complete") is True:
                counts["complete"] += 1
            if status == "failed":
                if record.get("exit_ip") is not None:
                    raise ResultStoreError(f"失败节点 {expected_index} 含有出口 IP")
            else:
                self._validate_exit_ip(record.get("exit_ip"))
        if manifest.get("counts") != counts:
            raise ResultStoreError("manifest 计数与节点文件不一致")

    def read_node(self, job_id: str, index: int) -> dict[str, Any]:
        if index < 0:
            raise ResultStoreError("节点索引不能为负数")
        return self._read_json(
            self._job_dir(job_id) / "nodes" / self._node_filename(index)
        )

    def read_summaries(self, job_id: str) -> list[dict[str, Any]]:
        manifest = self.read_manifest(job_id)
        records = manifest.get("records")
        if not isinstance(records, list):
            raise ResultStoreError("manifest records 无效")
        return [entry["summary"] for entry in records]

    def export(self, job_id: str, job: dict[str, Any]) -> dict[str, Any]:
        manifest = self.read_manifest(job_id)
        total = manifest.get("total")
        if not isinstance(total, int):
            raise ResultStoreError("manifest total 无效")
        results = [self.read_node(job_id, index) for index in range(total)]
        return {
            key: value
            for key, value in {
                **job,
                "results": results,
                "manifest": manifest,
            }.items()
            if key != "subscription_url"
        }

    @staticmethod
    def _summary(record: dict[str, Any]) -> dict[str, Any]:
        return {key: record.get(key) for key in _SUMMARY_KEYS}

    @staticmethod
    def _validate_exit_ip(value: Any) -> None:
        try:
            ipaddress.ip_address(value)
        except (TypeError, ValueError) as exc:
            raise ResultStoreError("成功节点缺少合法出口 IP") from exc

    @staticmethod
    def _node_filename(index: int) -> str:
        return f"{index:04d}.json"

    def _job_dir(self, job_id: str) -> Path:
        if not _JOB_ID_RE.fullmatch(job_id):
            raise ResultStoreError("任务 ID 非法")
        return self.root / job_id

    @staticmethod
    def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            with temp_path.open("w", encoding="utf-8", newline="\n") as output:
                json.dump(payload, output, ensure_ascii=False, indent=2, allow_nan=False)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp_path, path)
            try:
                directory_fd = os.open(path.parent, os.O_RDONLY)
            except OSError:
                directory_fd = None
            if directory_fd is not None:
                try:
                    os.fsync(directory_fd)
                except OSError:
                    pass
                finally:
                    os.close(directory_fd)
        finally:
            if temp_path.exists():
                temp_path.unlink()

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise ResultStoreError(f"暂存结果不存在：{path.name}") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise ResultStoreError(f"暂存结果不可读：{path.name}") from exc
        if not isinstance(payload, dict):
            raise ResultStoreError(f"暂存结果格式无效：{path.name}")
        return payload


result_store = ResultStore()
