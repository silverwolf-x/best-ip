from __future__ import annotations

# ruff: noqa: E402
import argparse
import asyncio
import hashlib
import json
import os
import statistics
import sys
import tempfile
from contextlib import suppress
from pathlib import Path
from time import perf_counter
from typing import Any
from uuid import uuid4

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import httpx

from backend.app.config import settings
from backend.app.subscription import (
    download_subscription,
    is_subscription_metadata,
    parse_subscription,
)
from scripts.verify_real_scan import _validate_local_api_base


async def run_once(
    client: httpx.AsyncClient,
    api_base: str,
    subscription_url: str,
    snapshot_sha256: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    request_id = uuid4().hex
    started = perf_counter()
    response = await client.post(
        f"{api_base}/api/scans",
        json={
            "subscription_url": subscription_url,
            "subscription_sha256": snapshot_sha256,
            "request_id": request_id,
        },
    )
    response.raise_for_status()
    created = response.json()
    if created.get("id") != request_id:
        raise RuntimeError("benchmark 任务 ID 不一致")
    try:
        while True:
            if perf_counter() - started > timeout_seconds:
                raise TimeoutError("benchmark 扫描超时")
            current = (await client.get(f"{api_base}/api/scans/{request_id}")).json()
            if current.get("id") != request_id:
                raise RuntimeError("benchmark 状态任务 ID 不一致")
            if current.get("status") in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(1)
        if current.get("status") != "completed" or current.get("manifest_ready") is not True:
            raise RuntimeError("benchmark 扫描未完成")
        exported = (await client.get(f"{api_base}/api/scans/{request_id}/export")).json()
    except BaseException:
        with suppress(httpx.HTTPError):
            await client.delete(f"{api_base}/api/scans/{request_id}", timeout=30)
        raise
    elapsed = perf_counter() - started
    records = exported.get("results") if isinstance(exported, dict) else []
    node_elapsed = [
        int(record["elapsed_ms"])
        for record in records
        if isinstance(record, dict) and isinstance(record.get("elapsed_ms"), int)
    ]
    metrics = current.get("metrics") if isinstance(current, dict) else {}
    p95_index = min(len(node_elapsed) - 1, max(0, int(len(node_elapsed) * 0.95) - 1))
    return {
        "wall_seconds": round(elapsed, 3),
        "nodes": exported.get("total"),
        "nodes_per_second": round(float(exported.get("total") or 0) / elapsed, 4),
        "success": exported.get("success_count"),
        "partial": exported.get("partial_count"),
        "failed": exported.get("failed_count"),
        "retry_sum": sum(int(record.get("retry_count") or 0) for record in records),
        "node_p50_ms": statistics.median(node_elapsed) if node_elapsed else None,
        "node_p95_ms": sorted(node_elapsed)[p95_index] if node_elapsed else None,
        "metrics": metrics,
        "cleanup_confirmed": exported.get("cleanup_confirmed") is True,
    }


async def main_async(args: argparse.Namespace) -> None:
    subscription_url = os.environ.get("BEST_IP_TEST_SUBSCRIPTION_URL", "").strip()
    if not subscription_url:
        raise RuntimeError("请通过被忽略的 .env 注入 BEST_IP_TEST_SUBSCRIPTION_URL")
    api_base = _validate_local_api_base(
        os.environ.get("BEST_IP_API_BASE", "http://127.0.0.1:8000")
    )
    content = await download_subscription(
        subscription_url,
        max_bytes=settings.subscription_max_bytes,
        timeout_seconds=settings.subscription_timeout_seconds,
    )
    snapshot_sha256 = hashlib.sha256(content).hexdigest()
    parsed = parse_subscription(content, max_nodes=settings.max_nodes)
    node_count = sum(not is_subscription_metadata(proxy) for proxy in parsed)
    if node_count < 1:
        raise RuntimeError("订阅没有真实节点")
    timeout = httpx.Timeout(30.0, connect=15.0)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        warmups = []
        for _ in range(args.warmup):
            warmups.append(
                await run_once(
                    client,
                    api_base,
                    subscription_url,
                    snapshot_sha256,
                    args.timeout,
                )
            )
        runs = []
        for _ in range(args.runs):
            runs.append(
                await run_once(
                    client,
                    api_base,
                    subscription_url,
                    snapshot_sha256,
                    args.timeout,
                )
            )
    output = {
        "schema_version": 1,
        "label": args.label,
        "snapshot_sha256": snapshot_sha256,
        "node_count": node_count,
        "warmup_count": len(warmups),
        "runs": runs,
        "wall_seconds_median": statistics.median(item["wall_seconds"] for item in runs),
        "nodes_per_second_median": statistics.median(item["nodes_per_second"] for item in runs),
    }
    output_path = (
        Path(args.output)
        if args.output
        else Path(tempfile.gettempdir()) / f"best-ip-benchmark-{args.label}.json"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {key: value for key, value in output.items() if key != "snapshot_sha256"},
            ensure_ascii=False,
        )
    )
    print(f"benchmark aggregate written outside source tree: {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run a fixed-subscription Best IP throughput benchmark"
    )
    parser.add_argument("--label", default="run")
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.warmup < 0 or args.runs < 1 or args.timeout <= 0:
        raise SystemExit("warmup/runs/timeout 参数无效")
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
