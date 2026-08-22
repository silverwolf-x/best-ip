from __future__ import annotations

# ruff: noqa: E402
import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app.result_store import ResultStoreError, result_store
from scripts.verify_real_scan import (
    _contains_forbidden_value,
    _subscription_url_values,
)

_DENY_KEYS = {
    "authorization",
    "auth_str",
    "cookie",
    "password",
    "passphrase",
    "private_key",
    "secret",
    "subscription_url",
    "token",
    "uuid",
}
_DENY_QUERY_KEYS = {"access_token", "auth", "key", "password", "secret", "token"}
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _walk_forbidden(value: Any, forbidden: set[str], path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized in _DENY_KEYS:
                raise RuntimeError(f"artifact 包含禁止字段：{path}.{key}")
            _walk_forbidden(child, forbidden, f"{path}.{key}")
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            _walk_forbidden(child, forbidden, f"{path}[{index}]")
        return
    if isinstance(value, str):
        parsed = urlsplit(value)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if any(key.lower() in _DENY_QUERY_KEYS and values for key, values in query.items()):
            raise RuntimeError(f"artifact 包含带凭据 URL：{path}")
        if _contains_forbidden_value(value, forbidden):
            raise RuntimeError(f"artifact 包含订阅凭据：{path}")


def _read_export(job_id: str) -> dict[str, Any]:
    manifest = result_store.read_manifest(job_id)
    progress = result_store.read_progress(job_id)
    job = {
        "id": job_id,
        "status": "completed",
        "message": progress.get("phase"),
        "created_at": manifest.get("created_at"),
        "finished_at": manifest.get("finished_at"),
        "cleanup_confirmed": progress.get("cleanup_confirmed") is True,
    }
    return result_store.export(job_id, job)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a sanitized GitHub Actions result artifact"
    )
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--run-attempt", required=True, type=int)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    if not _REQUEST_ID_RE.fullmatch(args.job_id) or args.job_id != args.request_id:
        raise SystemExit("任务 ID 与请求 ID 不一致")
    if args.run_id < 1 or args.run_attempt < 1:
        raise SystemExit("运行身份无效")
    source_url = os.environ.get("BEST_IP_TEST_SUBSCRIPTION_URL", "").strip()
    if not source_url:
        raise SystemExit("缺少临时订阅上下文")
    try:
        exported = _read_export(args.job_id)
    except ResultStoreError as exc:
        raise SystemExit("结果 manifest 校验失败") from exc
    forbidden = {source_url, *_subscription_url_values(source_url)}
    _walk_forbidden(exported, forbidden)
    serialized = json.dumps(exported, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if "subscription_url" in serialized or _contains_forbidden_value(exported, forbidden):
        raise SystemExit("结果包含订阅凭据")

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    result_path = output_dir / "result.json"
    status_path = output_dir / "status.json"
    result_bytes = (
        json.dumps(exported, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    result_path.write_bytes(result_bytes)
    digest = hashlib.sha256(result_bytes).hexdigest()
    counts = exported.get("manifest", {}).get("counts", {})
    status = {
        "schema_version": 1,
        "sanitized": True,
        "request_id": args.request_id,
        "run_id": args.run_id,
        "run_attempt": args.run_attempt,
        "status": "completed",
        "usable": int(counts.get("failed", 0) or 0) == 0
        and int(counts.get("partial", 0) or 0) == 0,
        "total": exported.get("total"),
        "completed": exported.get("completed"),
        "counts": counts,
        "result_sha256": digest,
    }
    status_path.write_text(
        json.dumps(status, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"已生成脱敏扫描 artifact：{args.request_id}")


if __name__ == "__main__":
    main()
