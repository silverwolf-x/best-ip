from __future__ import annotations

# ruff: noqa: E402
import argparse
import os
import sys
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app.results.artifact import build_artifact, subscription_url_values
from backend.app.results.store import ResultStoreError, result_store


def _read_export(job_id: str) -> dict[str, Any]:
    progress = result_store.read_progress(job_id)
    job = {
        "id": job_id,
        "status": "completed",
        "message": progress.get("phase"),
        "cleanup_confirmed": progress.get("cleanup_confirmed") is True,
    }
    return result_store.export(job_id, job)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a sanitized GitHub Actions result artifact")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--run-attempt", required=True, type=int)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    if args.job_id != args.request_id:
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
    forbidden = {source_url, *subscription_url_values(source_url)}
    result_bytes, status_bytes = build_artifact(
        exported, args.request_id, args.run_id, args.run_attempt, forbidden
    )
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    (output_dir / "result.json").write_bytes(result_bytes)
    (output_dir / "status.json").write_bytes(status_bytes)
    print(f"已生成脱敏扫描 artifact：{args.request_id}")


if __name__ == "__main__":
    main()
