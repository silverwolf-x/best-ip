from __future__ import annotations

import asyncio
import ipaddress
import json
import os
from typing import Any

import httpx


async def _get_json(client: httpx.AsyncClient, path: str) -> dict[str, Any]:
    response = await client.get(path)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"API 响应不是对象：{path}")
    return payload


async def verify() -> None:
    subscription_url = os.environ.get("BEST_IP_TEST_SUBSCRIPTION_URL", "").strip()
    if not subscription_url:
        raise RuntimeError(
            "请通过 BEST_IP_TEST_SUBSCRIPTION_URL 注入正式测试订阅；不要把 token 写入仓库"
        )

    api_base = os.environ.get("BEST_IP_API_BASE", "http://127.0.0.1:8000").rstrip("/")
    timeout_seconds = float(os.environ.get("BEST_IP_REAL_SCAN_TIMEOUT_SECONDS", "1800"))
    if timeout_seconds <= 0:
        raise RuntimeError("BEST_IP_REAL_SCAN_TIMEOUT_SECONDS 必须大于 0")

    timeout = httpx.Timeout(15.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        created_response = await client.post(
            f"{api_base}/api/scans",
            json={"subscription_url": subscription_url},
        )
        created_response.raise_for_status()
        created = created_response.json()
        job_id = created.get("id") if isinstance(created, dict) else None
        if not isinstance(job_id, str) or not job_id:
            raise RuntimeError("创建扫描未返回任务 ID")
        print(f"已创建正式订阅扫描任务：{job_id}")

        deadline = asyncio.get_running_loop().time() + timeout_seconds
        job: dict[str, Any]
        last_status: tuple[Any, ...] | None = None
        while True:
            job = await _get_json(client, f"{api_base}/api/scans/{job_id}")
            marker = (
                job.get("status"),
                job.get("completed"),
                job.get("total"),
                job.get("success_count"),
                job.get("partial_count"),
                job.get("failed_count"),
            )
            if marker != last_status:
                print(
                    "状态："
                    f"{marker[0]} {marker[1]}/{marker[2]}，"
                    f"完整 {marker[3]}，部分 {marker[4]}，失败 {marker[5]}"
                )
                last_status = marker
            if job.get("status") in {"completed", "failed", "cancelled"}:
                break
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError(f"正式扫描超过 {timeout_seconds:g} 秒")
            await asyncio.sleep(2)

        if job.get("status") != "completed" or job.get("manifest_ready") is not True:
            raise RuntimeError(f"正式扫描未完成：{job.get('error') or job.get('message')}")

        total = job.get("total")
        if not isinstance(total, int) or total < 1:
            raise RuntimeError("完成任务没有合法 total")
        if job.get("completed") != total:
            raise RuntimeError("完成任务的 completed 与 total 不一致")
        if sum(
            int(job.get(key) or 0)
            for key in ("success_count", "partial_count", "failed_count")
        ) != total:
            raise RuntimeError("完成任务的状态计数与 total 不一致")

        manifest = job.get("manifest")
        if not isinstance(manifest, dict) or manifest.get("complete") is not True:
            raise RuntimeError("完成任务缺少完整 manifest")
        records = manifest.get("records")
        if not isinstance(records, list) or len(records) != total:
            raise RuntimeError("manifest records 数量与 total 不一致")

        for index in range(total):
            record = await _get_json(
                client,
                f"{api_base}/api/scans/{job_id}/results/{index}",
            )
            if record.get("node_index") != index or record.get("job_id") != job_id:
                raise RuntimeError(f"节点 {index} 身份校验失败")
            status = record.get("status")
            exit_ip = record.get("exit_ip")
            if status in {"success", "partial"}:
                try:
                    ipaddress.ip_address(exit_ip)
                except (TypeError, ValueError) as exc:
                    raise RuntimeError(f"节点 {index} 出口 IP 非法") from exc
                evidence = record.get("proxy_evidence")
                selection_confirmed = (
                    isinstance(evidence, dict)
                    and evidence.get("selection_confirmed") is True
                )
                if not selection_confirmed:
                    raise RuntimeError(f"节点 {index} 缺少 selector 身份确认")
            elif status == "failed":
                if exit_ip is not None:
                    raise RuntimeError(f"失败节点 {index} 含有出口 IP")
                if not str(record.get("error") or "").strip():
                    raise RuntimeError(f"失败节点 {index} 缺少错误原因")
            else:
                raise RuntimeError(f"节点 {index} 状态无效：{status}")

        exported = await _get_json(client, f"{api_base}/api/scans/{job_id}/export")
        export_manifest = exported.get("manifest")
        if not isinstance(export_manifest, dict) or export_manifest.get("complete") is not True:
            raise RuntimeError("导出缺少完整 manifest")
        if len(exported.get("results") or []) != total:
            raise RuntimeError("导出结果数量与 total 不一致")

        serialized = json.dumps({"job": job, "export": exported}, ensure_ascii=False)
        if "subscription_url" in serialized or subscription_url in serialized:
            raise RuntimeError("任务状态或导出泄露订阅凭据")
        print(f"正式订阅闭环通过：{total} 个节点均有终态记录，manifest/export 校验通过")


def main() -> None:
    try:
        asyncio.run(verify())
    except (httpx.HTTPError, TimeoutError, RuntimeError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
