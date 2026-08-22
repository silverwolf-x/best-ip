from __future__ import annotations

# ruff: noqa: E402
import asyncio
import hashlib
import ipaddress
import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4

import httpx
import yaml

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app.config import JOBS_DIR, RESULTS_DIR, settings
from backend.app.jobs import _TRANSPORT_ERROR_TYPES
from backend.app.result_store import result_store
from backend.app.scanner import _is_same_ip, _trace_ip
from backend.app.subscription import (
    download_subscription,
    is_subscription_metadata,
    parse_subscription,
)

_CREDENTIAL_KEYS = {
    "auth",
    "auth-str",
    "authorization",
    "cookie",
    "obfs-password",
    "password",
    "pre-shared-key",
    "preshared-key",
    "private-key",
    "private-key-passphrase",
    "psk",
    "secret",
    "token",
    "username",
    "uuid",
}


def _credential_values(content: bytes) -> set[str]:
    try:
        document = yaml.safe_load(content.decode("utf-8-sig"))
    except (UnicodeDecodeError, yaml.YAMLError):
        return set()

    values: set[str] = set()

    def visit(value: Any, key: str = "") -> None:
        if isinstance(value, dict):
            for child_key, child_value in value.items():
                normalized_key = str(child_key).strip().lower().replace("_", "-")
                visit(child_value, normalized_key)
        elif isinstance(value, list):
            for child in value:
                visit(child, key)
        elif key in _CREDENTIAL_KEYS:
            text = str(value).strip()
            if text:
                values.add(text)

    visit(document)
    return values


def _contains_forbidden_value(value: Any, forbidden_values: set[str]) -> bool:
    if isinstance(value, dict):
        return any(
            _contains_forbidden_value(child, forbidden_values)
            for child in value.values()
        )
    if isinstance(value, list):
        return any(
            _contains_forbidden_value(child, forbidden_values)
            for child in value
        )
    if isinstance(value, bool) or value is None:
        return False
    text = str(value)
    return any(
        text == forbidden or (len(forbidden) >= 6 and forbidden in text)
        for forbidden in forbidden_values
    )


_STATIC_SUBSCRIPTION_PATH_SEGMENTS = {
    "api",
    "client",
    "clients",
    "clash",
    "config",
    "configs",
    "download",
    "feed",
    "feeds",
    "link",
    "links",
    "mihomo",
    "profile",
    "profiles",
    "subscribe",
    "subscription",
    "subscriptions",
    "yaml",
    "yml",
}


_STATIC_SUBSCRIPTION_QUERY_VALUES = {
    "auto",
    "base64",
    "clash",
    "false",
    "mihomo",
    "plain",
    "true",
    "yaml",
    "yml",
}


def _looks_like_subscription_query_token(value: str) -> bool:
    return (
        len(value) >= 6
        and not any(character.isspace() for character in value)
        and value.casefold() not in _STATIC_SUBSCRIPTION_QUERY_VALUES
    )


def _looks_like_subscription_path_token(value: str) -> bool:
    return (
        len(value) >= 6
        and not any(character.isspace() for character in value)
        and value.casefold() not in _STATIC_SUBSCRIPTION_PATH_SEGMENTS
    )


def _subscription_url_values(url: str) -> set[str]:
    parsed = urlsplit(url)
    values: set[str] = set()
    for key, query_values in parse_qs(
        parsed.query,
        keep_blank_values=False,
    ).items():
        normalized_key = key.strip().lower().replace("_", "-")
        sensitive_key = any(
            marker in normalized_key
            for marker in ("auth", "key", "pass", "secret", "token", "uuid")
        )
        for query_value in query_values:
            value = query_value.strip()
            if value and (
                sensitive_key or _looks_like_subscription_query_token(value)
            ):
                values.add(value)
    values.update(
        segment
        for segment in (unquote(item).strip() for item in parsed.path.split("/"))
        if _looks_like_subscription_path_token(segment)
    )
    return values


def _validate_local_api_base(api_base: str) -> str:
    parsed = urlsplit(api_base)
    try:
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("BEST_IP_API_BASE 端口无效") from exc
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or port is None
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("BEST_IP_API_BASE 必须是带端口的本机 HTTP 地址")
    return api_base.rstrip("/")


def _require_no_failed_nodes(job: dict[str, Any]) -> None:
    failed_count = job.get("failed_count")
    if not isinstance(failed_count, int) or failed_count < 0:
        raise RuntimeError("正式订阅没有合法失败节点计数")
    if failed_count and os.environ.get("BEST_IP_ALLOW_PARTIAL") != "1":
        raise RuntimeError(
            f"正式订阅可用性验收失败：{failed_count} 个节点未获得有效结果"
        )


async def _cancel_scan(
    client: httpx.AsyncClient,
    api_base: str,
    job_id: str,
    *,
    allow_not_found: bool = False,
) -> dict[str, Any]:
    response = await client.delete(
        f"{api_base}/api/scans/{job_id}",
        timeout=30.0,
    )
    if response.status_code == 404:
        if allow_not_found and not (JOBS_DIR / job_id).exists():
            return {"status": "cancelled", "cleanup_confirmed": True}
        raise RuntimeError("扫描任务不存在，无法确认 Mihomo 清理终态")
    response.raise_for_status()
    payload = response.json()
    if (
        not isinstance(payload, dict)
        or payload.get("id") != job_id
        or payload.get("status") not in {"cancelled", "completed", "failed"}
        or payload.get("cleanup_confirmed") is not True
    ):
        raise RuntimeError("取消扫描未返回已确认的任务和 Mihomo 清理终态")
    return payload


async def _get_json(client: httpx.AsyncClient, path: str) -> dict[str, Any]:
    response = await client.get(path)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"API 响应不是对象：{path}")
    return payload


async def _get_before_deadline(
    client: httpx.AsyncClient,
    path: str,
    *,
    deadline: float,
) -> dict[str, Any]:
    remaining = deadline - asyncio.get_running_loop().time()
    if remaining <= 0:
        raise TimeoutError("正式扫描验收超过总时间预算")
    return await asyncio.wait_for(
        _get_json(client, path),
        timeout=remaining,
    )


async def verify() -> None:
    subscription_url = os.environ.get("BEST_IP_TEST_SUBSCRIPTION_URL", "").strip()
    if not subscription_url:
        raise RuntimeError(
            "请通过 BEST_IP_TEST_SUBSCRIPTION_URL 注入正式测试订阅；不要把 token 写入仓库"
        )

    api_base = _validate_local_api_base(
        os.environ.get("BEST_IP_API_BASE", "http://127.0.0.1:8000")
    )
    timeout_seconds = float(os.environ.get("BEST_IP_REAL_SCAN_TIMEOUT_SECONDS", "1800"))
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise RuntimeError("BEST_IP_REAL_SCAN_TIMEOUT_SECONDS 必须是大于 0 的有限数")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_seconds

    subscription_content = await asyncio.wait_for(
        download_subscription(
            subscription_url,
            max_bytes=settings.subscription_max_bytes,
            timeout_seconds=min(
                settings.subscription_timeout_seconds,
                timeout_seconds,
            ),
        ),
        timeout=max(0.001, deadline - loop.time()),
    )
    credential_values = _credential_values(subscription_content)
    subscription_sha256 = hashlib.sha256(subscription_content).hexdigest()
    parsed_proxies = parse_subscription(
        subscription_content,
        max_nodes=settings.max_nodes,
    )
    expected_nodes = [
        str(proxy["name"])
        for proxy in parsed_proxies
        if not is_subscription_metadata(proxy)
    ]
    expected_skipped = len(parsed_proxies) - len(expected_nodes)

    timeout = httpx.Timeout(15.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        requested_job_id = os.environ.get("BEST_IP_REQUEST_ID", "").strip()
        if requested_job_id and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", requested_job_id):
            raise RuntimeError("BEST_IP_REQUEST_ID 格式无效")
        job_id = requested_job_id or uuid4().hex
        try:
            created_response = await asyncio.wait_for(
                client.post(
                    f"{api_base}/api/scans",
                    json={
                        "subscription_url": subscription_url,
                        "subscription_sha256": subscription_sha256,
                        "request_id": job_id,
                    },
                ),
                timeout=max(0.001, deadline - loop.time()),
            )
            created_response.raise_for_status()
            created = created_response.json()
            created_job_id = created.get("id") if isinstance(created, dict) else None
            if created_job_id != job_id:
                raise RuntimeError("创建扫描未返回请求绑定的任务 ID")
        except BaseException:
            try:
                await asyncio.wait_for(
                    _cancel_scan(
                        client,
                        api_base,
                        job_id,
                        allow_not_found=True,
                    ),
                    timeout=35.0,
                )
            except (httpx.HTTPError, RuntimeError, TimeoutError) as cancel_exc:
                raise RuntimeError(
                    "创建正式扫描未完成，且未确认请求未启动或后台任务已终止"
                ) from cancel_exc
            raise
        print(f"已创建正式订阅扫描任务：{job_id}")

        job: dict[str, Any] = {}
        last_status: tuple[Any, ...] | None = None
        terminal_statuses = {"completed", "failed", "cancelled"}
        try:
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise TimeoutError(f"正式扫描超过 {timeout_seconds:g} 秒")
                job = await _get_before_deadline(
                    client,
                    f"{api_base}/api/scans/{job_id}",
                    deadline=deadline,
                )
                if job.get("id") != job_id:
                    raise RuntimeError("扫描状态响应与请求任务 ID 不一致")
                completed = job.get("completed")
                results = job.get("results")
                if not isinstance(completed, int) or completed < 0:
                    raise RuntimeError("扫描状态没有合法 completed")
                if not isinstance(results, list) or len(results) != completed:
                    raise RuntimeError("进行中节点摘要数量与 completed 不一致")
                result_indices = sorted(
                    result.get("node_index")
                    for result in results
                    if isinstance(result, dict)
                    and isinstance(result.get("node_index"), int)
                )
                if (
                    len(result_indices) != completed
                    or len(set(result_indices)) != completed
                    or any(
                        index < 0 or index >= int(job.get("total") or 0)
                        for index in result_indices
                    )
                ):
                    raise RuntimeError("进行中节点摘要身份或索引无效")
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
                if job.get("status") in terminal_statuses:
                    break
                await asyncio.sleep(min(2, max(0, deadline - loop.time())))
        except BaseException:
            try:
                await asyncio.wait_for(
                    _cancel_scan(client, api_base, job_id),
                    timeout=35.0,
                )
            except (httpx.HTTPError, RuntimeError, TimeoutError) as cancel_exc:
                raise RuntimeError(
                    "正式扫描验收中止，且未确认后台任务和 Mihomo 进程已终止"
                ) from cancel_exc
            raise

        if (
            job.get("status") != "completed"
            or job.get("manifest_ready") is not True
            or job.get("cleanup_confirmed") is not True
        ):
            raise RuntimeError(
                f"正式扫描未完成（状态：{job.get('status') or 'unknown'}）"
            )

        total = job.get("total")
        if not isinstance(total, int) or total < 1:
            raise RuntimeError("完成任务没有合法 total")
        if total != len(expected_nodes) or job.get("skipped") != expected_skipped:
            raise RuntimeError("任务节点数或 metadata 数与订阅快照不一致")
        if job.get("completed") != total:
            raise RuntimeError("完成任务的 completed 与 total 不一致")
        if sum(
            int(job.get(key) or 0)
            for key in ("success_count", "partial_count", "failed_count")
        ) != total:
            raise RuntimeError("完成任务的状态计数与 total 不一致")

        manifest = job.get("manifest")
        if (
            not isinstance(manifest, dict)
            or manifest.get("complete") is not True
            or manifest.get("all_records_present") is not True
            or manifest.get("completed") != total
        ):
            raise RuntimeError("完成任务缺少完整 manifest")
        if manifest.get("job_id") != job_id or manifest.get("status") != "completed":
            raise RuntimeError("manifest 任务身份或状态不一致")
        records = manifest.get("records")
        if not isinstance(records, list) or len(records) != total:
            raise RuntimeError("manifest records 数量与 total 不一致")
        if [entry.get("index") for entry in records if isinstance(entry, dict)] != list(
            range(total)
        ):
            raise RuntimeError("manifest 节点索引不连续")
        counts = manifest.get("counts")
        expected_counts = {
            "success": int(job.get("success_count") or 0),
            "partial": int(job.get("partial_count") or 0),
            "failed": int(job.get("failed_count") or 0),
        }
        if not isinstance(counts, dict) or any(
            counts.get(key) != value for key, value in expected_counts.items()
        ):
            raise RuntimeError("manifest 计数与任务状态不一致")

        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("正式扫描验收超过总时间预算")
        if (JOBS_DIR / job_id).exists():
            raise RuntimeError("Mihomo 临时工作目录未清理")
        local_result_dir = RESULTS_DIR / job_id
        if not local_result_dir.is_dir():
            raise RuntimeError("未找到本地结果目录，无法复核 manifest 节点 hash")
        local_manifest = result_store.read_manifest(job_id)
        if local_manifest != manifest:
            raise RuntimeError("API manifest 与本地 hash 校验结果不一致")

        node_records: list[dict[str, Any]] = []
        for index in range(total):
            record = await _get_before_deadline(
                client,
                f"{api_base}/api/scans/{job_id}/results/{index}",
                deadline=deadline,
            )
            local_record = result_store.read_node(job_id, index)
            if record != local_record:
                raise RuntimeError(f"节点 {index} API 结果与本地 hash 绑定记录不一致")
            expected_node = expected_nodes[index]
            if (
                record.get("node_index") != index
                or record.get("job_id") != job_id
                or record.get("node") != expected_node
            ):
                raise RuntimeError(f"节点 {index} 身份校验失败")
            node_records.append(record)
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
                if (
                    evidence.get("trust_env") is not False
                    or evidence.get("direct_fallback") is not False
                    or evidence.get("transport") != "workspace_mihomo_mixed_port"
                    or evidence.get("selected_proxy") != record.get("node")
                ):
                    raise RuntimeError(f"节点 {index} 代理证据无效")
                requests = record.get("requests")
                page = requests.get("page") if isinstance(requests, dict) else None
                trace = requests.get("trace") if isinstance(requests, dict) else None
                lookup = requests.get("lookup") if isinstance(requests, dict) else None
                lookup_data = (
                    lookup.get("data") if isinstance(lookup, dict) else None
                )
                if (
                    not isinstance(page, dict)
                    or page.get("ok") is not True
                    or page.get("via_mihomo") is not True
                    or page.get("proxy_url") != evidence.get("proxy_url")
                    or not isinstance(trace, dict)
                    or trace.get("ok") is not True
                    or trace.get("via_mihomo") is not True
                    or trace.get("proxy_url") != evidence.get("proxy_url")
                    or _trace_ip(trace.get("data")) != exit_ip
                    or not isinstance(lookup, dict)
                    or lookup.get("ok") is not True
                    or lookup.get("via_mihomo") is not True
                    or lookup.get("proxy_url") != evidence.get("proxy_url")
                    or not isinstance(lookup_data, dict)
                    or not _is_same_ip(lookup_data.get("ip"), exit_ip)
                ):
                    raise RuntimeError(f"节点 {index} trace/lookup 证据无效")
                completeness = record.get("completeness")
                checks = (
                    completeness.get("checks")
                    if isinstance(completeness, dict)
                    else None
                )
                if (
                    not isinstance(checks, dict)
                    or checks.get("page_received") is not True
                    or checks.get("trace_received") is not True
                    or checks.get("exit_ip_valid") is not True
                    or checks.get("lookup_received") is not True
                    or checks.get("lookup_matches_trace") is not True
                ):
                    raise RuntimeError(f"节点 {index} 完整性证据无效")
            elif status == "failed":
                if exit_ip is not None:
                    raise RuntimeError(f"失败节点 {index} 含有出口 IP")
                if not str(record.get("error") or "").strip():
                    raise RuntimeError(f"失败节点 {index} 缺少错误原因")
                requests = record.get("requests")
                has_connect_error = isinstance(requests, dict) and any(
                    isinstance(request, dict)
                    and request.get("error_type") in _TRANSPORT_ERROR_TYPES
                    for request in requests.values()
                )
                if has_connect_error and not str(
                    record.get("transport_error") or ""
                ).strip():
                    raise RuntimeError(f"失败节点 {index} 缺少传输层错误原因")
            else:
                raise RuntimeError(f"节点 {index} 状态无效：{status}")

        exported = await _get_before_deadline(
            client,
            f"{api_base}/api/scans/{job_id}/export",
            deadline=deadline,
        )
        export_manifest = exported.get("manifest")
        export_results = exported.get("results")
        if export_manifest != manifest:
            raise RuntimeError("导出 manifest 与已核验 manifest 不一致")
        if (
            exported.get("id") != job_id
            or exported.get("status") != "completed"
            or exported.get("total") != total
            or any(
                exported.get(key) != job.get(key)
                for key in (
                    "created_at",
                    "finished_at",
                    "skipped",
                    "completed",
                    "success_count",
                    "partial_count",
                    "failed_count",
                    "manifest_ready",
                    "cleanup_confirmed",
                    "execution_mode",
                )
            )
        ):
            raise RuntimeError("导出任务身份或计数与已核验任务不一致")
        if export_results != node_records:
            raise RuntimeError("导出节点结果与逐节点核验快照不一致")

        api_payload = {"job": job, "export": exported}
        serialized = json.dumps(api_payload, ensure_ascii=False)
        forbidden_values = {
            subscription_url,
            *credential_values,
            *_subscription_url_values(subscription_url),
        }
        if "subscription_url" in serialized or _contains_forbidden_value(
            api_payload,
            forbidden_values,
        ):
            raise RuntimeError("任务状态或导出泄露订阅凭据")
        for path in local_result_dir.rglob("*"):
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError("正式扫描验收超过总时间预算")
            if not path.is_file():
                continue
            content = path.read_text(encoding="utf-8", errors="strict")
            try:
                stored_payload = json.loads(content)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"暂存文件不是有效 JSON：{path.name}") from exc
            if "subscription_url" in content or _contains_forbidden_value(
                stored_payload,
                forbidden_values,
            ):
                raise RuntimeError(f"暂存文件泄露订阅凭据：{path.name}")
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("正式扫描验收超过总时间预算")
        print(
            f"正式订阅结构闭环通过：{total} 个节点均有终态记录，"
            "manifest/export 校验通过"
        )
        _require_no_failed_nodes(job)
        print(f"正式订阅可用性验收通过：{total} 个节点均获得有效结果")


def main() -> None:
    try:
        asyncio.run(verify())
    except httpx.HTTPError as exc:
        raise SystemExit(
            f"正式订阅闭环失败（{exc.__class__.__name__}）"
        ) from exc
    except (TimeoutError, RuntimeError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
