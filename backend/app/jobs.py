from __future__ import annotations

import asyncio
import copy
import hashlib
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .config import JOBS_DIR, RESULTS_DIR, Settings, settings
from .mihomo import MihomoError, MihomoProcess, MihomoStopError
from .result_store import ResultStoreError, result_store
from .scanner import CoffeeCollector
from .subscription import (
    SubscriptionError,
    download_subscription,
    extract_subscription_dns,
    is_subscription_metadata,
    parse_subscription,
)


class JobNotFoundError(KeyError):
    pass


class JobNotReadyError(RuntimeError):
    pass


class JobAlreadyExistsError(RuntimeError):
    pass


class ScanJobManager:
    def __init__(self, app_settings: Settings = settings) -> None:
        self.settings = app_settings
        self.jobs: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self._semaphore = asyncio.Semaphore(app_settings.max_parallel_jobs)
        self.node_parallelism = app_settings.max_parallel_nodes

    def create(
        self,
        subscription_url: str,
        *,
        subscription_sha256: str | None = None,
        request_id: str | None = None,
    ) -> dict[str, str]:
        job_id = request_id or uuid4().hex
        if job_id in self.jobs:
            raise JobAlreadyExistsError(job_id)
        self.jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "message": "等待扫描资源",
            "created_at": _now(),
            "finished_at": None,
            "total": 0,
            "skipped": 0,
            "completed": 0,
            "success_count": 0,
            "partial_count": 0,
            "failed_count": 0,
            "current_node": None,
            "manifest_ready": False,
            "cleanup_confirmed": True,
            "execution_mode": "parallel" if self.node_parallelism > 1 else "sequential",
            "error": None,
        }
        self.tasks[job_id] = asyncio.create_task(
            self._run(
                job_id,
                subscription_url,
                subscription_sha256=subscription_sha256,
            )
        )
        return {"id": job_id, "status": "queued"}

    def get(self, job_id: str) -> dict[str, Any]:
        job = self.jobs.get(job_id)
        if job is None:
            raise JobNotFoundError(job_id)
        snapshot = copy.deepcopy(job)
        if job.get("status") == "completed" and job.get("manifest_ready"):
            try:
                snapshot["manifest"] = result_store.read_manifest(job_id)
                snapshot["results"] = result_store.read_summaries(job_id)
            except ResultStoreError as exc:
                snapshot["status"] = "failed"
                snapshot["manifest_ready"] = False
                snapshot["error"] = str(exc)
                snapshot["results"] = []
        else:
            snapshot["results"] = []
        return snapshot

    def get_result(self, job_id: str, index: int) -> dict[str, Any]:
        job = self.jobs.get(job_id)
        if job is None:
            raise JobNotFoundError(job_id)
        if job.get("status") != "completed" or not job.get("manifest_ready"):
            raise JobNotReadyError("扫描尚未生成 completed manifest")
        try:
            manifest = result_store.read_manifest(job_id)
            total = manifest.get("total")
            if not isinstance(total, int) or index < 0 or index >= total:
                raise JobNotFoundError(job_id)
            return result_store.read_node(job_id, index)
        except ResultStoreError as exc:
            raise JobNotFoundError(job_id) from exc

    def export(self, job_id: str) -> dict[str, Any]:
        job = self.jobs.get(job_id)
        if job is None:
            raise JobNotFoundError(job_id)
        if job.get("status") != "completed" or not job.get("manifest_ready"):
            raise JobNotReadyError("扫描尚未生成 completed manifest")
        try:
            return result_store.export(job_id, copy.deepcopy(job))
        except ResultStoreError as exc:
            raise JobNotReadyError(str(exc)) from exc

    async def cancel(self, job_id: str) -> dict[str, Any]:
        job = self.jobs.get(job_id)
        if job is None:
            raise JobNotFoundError(job_id)
        task = self.tasks.get(job_id)
        if task and not task.done():
            if not task.cancelling():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if job.get("status") == "queued":
            job["status"] = "cancelled"
            job["message"] = "扫描已取消"
            job["cleanup_confirmed"] = True
            job["finished_at"] = _now()
            await self._safe_write_progress(job)
        if (
            job.get("status") in {"completed", "failed", "cancelled"}
            and job.get("cleanup_confirmed") is not True
        ):
            raise JobNotReadyError("任务已终止，但 Mihomo 清理未确认")
        return self.get(job_id)

    async def shutdown(self) -> None:
        active = [task for task in self.tasks.values() if not task.done()]
        for task in active:
            if not task.cancelling():
                task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)
        for job in self.jobs.values():
            if job.get("status") == "queued":
                job["status"] = "cancelled"
                job["message"] = "扫描已取消"
                job["cleanup_confirmed"] = True
                job["finished_at"] = _now()
                await self._safe_write_progress(job)

    async def _run(
        self,
        job_id: str,
        subscription_url: str,
        *,
        subscription_sha256: str | None = None,
    ) -> None:
        job = self.jobs[job_id]
        work_dir = JOBS_DIR / job_id
        try:
            async with self._semaphore:
                job["status"] = "preparing"
                job["message"] = "正在安全下载并解析订阅"
                content = await download_subscription(
                    subscription_url,
                    max_bytes=self.settings.subscription_max_bytes,
                    timeout_seconds=self.settings.subscription_timeout_seconds,
                )
                if (
                    subscription_sha256 is not None
                    and hashlib.sha256(content).hexdigest() != subscription_sha256
                ):
                    raise SubscriptionError("订阅内容与请求快照不一致")
                subscription_dns = extract_subscription_dns(content)
                parsed_proxies = parse_subscription(content, max_nodes=self.settings.max_nodes)
                proxies = [
                    proxy for proxy in parsed_proxies if not is_subscription_metadata(proxy)
                ]
                job["skipped"] = len(parsed_proxies) - len(proxies)
                if not proxies:
                    raise SubscriptionError("订阅中没有可检测的代理节点")
                job["total"] = len(proxies)
                result_store.initialize(job_id, _progress(job))

                job["status"] = "running"
                job["message"] = f"正在并行检测 {len(proxies)} 个节点"
                await self._write_progress(job)
                job["cleanup_confirmed"] = False
                node_semaphore = asyncio.Semaphore(min(self.node_parallelism, len(proxies)))
                node_tasks = [
                    asyncio.create_task(
                        self._scan_node(
                            job,
                            work_dir,
                            proxies,
                            proxy,
                            index,
                            subscription_dns,
                            node_semaphore,
                        )
                    )
                    for index, proxy in enumerate(proxies)
                ]
                try:
                    await asyncio.gather(*node_tasks)
                except BaseException as exc:
                    for task in node_tasks:
                        if not task.done() and not task.cancelling():
                            task.cancel()
                    outcomes = await asyncio.gather(
                        *node_tasks,
                        return_exceptions=True,
                    )
                    if any(isinstance(outcome, MihomoStopError) for outcome in outcomes):
                        job["cleanup_confirmed"] = False
                        raise MihomoStopError("Mihomo 子进程清理未确认") from exc
                    job["cleanup_confirmed"] = True
                    raise
                job["cleanup_confirmed"] = True
                if not _remove_work_dir(work_dir):
                    job["cleanup_confirmed"] = False
                    raise OSError("Mihomo 工作目录清理失败")

                job["current_node"] = None
                job["finished_at"] = _now()
                result_store.finalize(job_id, job)
                job["status"] = "completed"
                job["manifest_ready"] = True
                suffix = f"，已跳过 {job['skipped']} 个订阅信息项" if job["skipped"] else ""
                job["message"] = f"扫描完成，共 {len(proxies)} 个节点{suffix}"
                await self._safe_write_progress(job)
        except asyncio.CancelledError:
            work_dir_removed = _remove_work_dir(work_dir)
            job["cleanup_confirmed"] = bool(
                job.get("cleanup_confirmed") and work_dir_removed
            )
            job["status"] = (
                "cancelled" if job["cleanup_confirmed"] else "failed"
            )
            job["message"] = (
                "扫描已取消"
                if job["cleanup_confirmed"]
                else "扫描取消后的清理未确认"
            )
            job["error"] = (
                None
                if job["cleanup_confirmed"]
                else "Mihomo 进程或工作目录清理未确认"
            )
            job["current_node"] = None
            job["finished_at"] = _now()
            await self._safe_write_progress(job)
        except Exception as exc:
            work_dir_removed = _remove_work_dir(work_dir)
            job["cleanup_confirmed"] = bool(
                job.get("cleanup_confirmed") and work_dir_removed
            )
            job["status"] = "failed"
            job["message"] = "扫描任务失败"
            job["current_node"] = None
            job["finished_at"] = _now()
            job["error"] = (
                _safe_job_error(exc)
                if job["cleanup_confirmed"]
                else "Mihomo 进程或工作目录清理未确认"
            )
            await self._safe_write_progress(job)
        finally:
            if work_dir.exists():
                job["cleanup_confirmed"] = False
            job["finished_at"] = job.get("finished_at") or _now()

    async def _scan_node(
        self,
        job: dict[str, Any],
        work_dir: Path,
        proxies: list[dict[str, Any]],
        proxy: dict[str, Any],
        index: int,
        subscription_dns: dict[str, Any] | None,
        node_semaphore: asyncio.Semaphore,
    ) -> None:
        async with node_semaphore:
            node_name = str(proxy["name"])
            node_type = str(proxy["type"])
            mihomo = MihomoProcess(
                self.settings.mihomo_path,
                work_dir / f"node-{index:04d}",
                proxies,
                dns_config=subscription_dns,
                selector_names=[node_name],
            )
            log_offset = 0
            try:
                job["message"] = f"正在并行检测 {index + 1}/{job['total']}：{node_name}"
                await mihomo.start()
                log_offset = mihomo.log_offset()
                selected = await mihomo.select(node_name)
                collector = CoffeeCollector(
                    mihomo.proxy_url,
                    timeout_ms=self.settings.page_timeout_ms,
                )
                result = await asyncio.wait_for(
                    collector.collect(
                        job_id=job["id"],
                        node_index=index,
                        node_name=node_name,
                        node_type=node_type,
                        selected_proxy=selected,
                        mihomo_instance=mihomo.instance_id,
                    ),
                    timeout=self.settings.page_timeout_ms / 1000,
                )
                _attach_mihomo_error(result, mihomo, log_offset)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                mihomo_error = _read_mihomo_error(mihomo, log_offset)
                result = _failed_node(
                    job["id"],
                    index,
                    node_name,
                    node_type,
                    exc,
                    mihomo_error=mihomo_error,
                    mihomo=mihomo,
                )
            finally:
                try:
                    await mihomo.stop()
                finally:
                    if not _remove_work_dir(mihomo.work_dir):
                        raise MihomoStopError("Mihomo 工作目录清理未确认")

            result_store.write_node(job["id"], index, result)
            _count_result(job, result)
            job["completed"] += 1
            await self._write_progress(job)

    async def _write_progress(self, job: dict[str, Any]) -> None:
        result_store.write_progress(job["id"], _progress(job))

    async def _safe_write_progress(self, job: dict[str, Any]) -> None:
        try:
            if (RESULTS_DIR / job["id"]).exists():
                await self._write_progress(job)
        except (OSError, ResultStoreError):
            pass


def _progress(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": job["id"],
        "status": job.get("status"),
        "phase": job.get("message"),
        "total": job.get("total", 0),
        "skipped": job.get("skipped", 0),
        "completed": job.get("completed", 0),
        "success_count": job.get("success_count", 0),
        "partial_count": job.get("partial_count", 0),
        "failed_count": job.get("failed_count", 0),
        "current_node": job.get("current_node"),
        "manifest_ready": job.get("manifest_ready", False),
        "cleanup_confirmed": job.get("cleanup_confirmed", True),
        "updated_at": _now(),
        "error": job.get("error"),
    }


def _count_result(job: dict[str, Any], result: dict[str, Any]) -> None:
    status = result.get("status")
    if status == "success":
        job["success_count"] += 1
    elif status == "partial":
        job["partial_count"] += 1
    else:
        job["failed_count"] += 1


_TRANSPORT_ERROR_TYPES = {
    "CloseError",
    "ConnectError",
    "ConnectTimeout",
    "LocalProtocolError",
    "NetworkError",
    "PoolTimeout",
    "ProtocolError",
    "ProxyError",
    "ReadError",
    "ReadTimeout",
    "RemoteProtocolError",
    "TimeoutException",
    "WriteError",
    "WriteTimeout",
}


def _read_mihomo_error(mihomo: MihomoProcess, offset: int) -> str:
    try:
        return mihomo.read_log_since(offset)
    except (OSError, ValueError):
        return ""


def _attach_mihomo_error(
    result: dict[str, Any], mihomo: MihomoProcess, offset: int
) -> None:
    requests = result.get("requests")
    if not isinstance(requests, dict) or not any(
        isinstance(request, dict)
        and request.get("error_type") in _TRANSPORT_ERROR_TYPES
        for request in requests.values()
    ):
        return

    message = _read_mihomo_error(mihomo, offset)
    transport_error = (
        _summarize_mihomo_error(message) if message else "节点传输连接失败"
    )
    result["transport_error"] = transport_error
    result["error"] = _merge_error(result.get("error"), transport_error)
    pages = result.get("pages")
    ip_page = pages.get("ip") if isinstance(pages, dict) else None
    if isinstance(ip_page, dict):
        ip_page["error"] = result["error"]


def _failed_node(
    job_id: str,
    index: int,
    node_name: str,
    node_type: str,
    exc: Exception,
    *,
    mihomo_error: str = "",
    mihomo: MihomoProcess | None = None,
) -> dict[str, Any]:
    transport_error = (
        _summarize_mihomo_error(mihomo_error)
        if mihomo_error
        else _safe_exception_error(exc)
    )
    error = transport_error
    return {
        "schema_version": 1,
        "job_id": job_id,
        "node_index": index,
        "node": node_name,
        "type": node_type,
        "status": "failed",
        "error": error,
        "phase": "selector" if isinstance(exc, MihomoError) else "collector",
        "started_at": _now(),
        "finished_at": _now(),
        "exit_ip": None,
        "selected_proxy": None,
        "requested_proxy": node_name,
        "proxy_evidence": {
            "transport": "workspace_mihomo_mixed_port",
            "proxy_url": mihomo.proxy_url if mihomo else None,
            "mihomo_instance": mihomo.instance_id if mihomo else None,
            "selector": MihomoProcess.group_name,
            "requested_proxy": node_name,
            "selection_confirmed": False,
            "target_origin": "https://ip.net.coffee",
            "trust_env": False,
            "direct_fallback": False,
        },
        "requests": {},
        "coffee": {},
        "completeness": {
            "complete": False,
            "required": {"page": False, "trace": False, "lookup": False},
            "optional": {},
            "missing": ["selector_or_collector"],
        },
        "transport_error": transport_error,
        "cidr": "",
        "rdns": "",
        "ai_verdict": "",
        "location": "",
        "score": None,
        "is_residential": None,
        "is_datacenter": None,
        "is_native": None,
        "traffic_profile": "未知",
        "company_type": "未知",
        "is_vpn": None,
        "is_proxy": None,
        "is_tor": None,
        "is_crawler": None,
        "is_abuser": None,
        "security_status": "检测失败",
        "asn": None,
        "as_org": "",
        "global_ping": [],
        "port_scan": None,
        "ping_check": None,
        "related_domains": [],
        "elapsed_ms": 0,
    }


def _summarize_mihomo_error(message: str) -> str:
    normalized = message.lower()
    if "dns resolve failed" in normalized or "no such host" in normalized:
        return "节点服务器域名无法解析"
    if "reality authentication failed" in normalized:
        return "节点 REALITY 认证失败"
    if "context deadline exceeded" in normalized or "i/o timeout" in normalized:
        return "连接节点服务器超时"
    if "connection refused" in normalized:
        return "节点服务器拒绝连接"
    if "tls handshake" in normalized:
        return "节点 TLS 握手失败"
    if "connection reset" in normalized:
        return "节点服务器重置连接"
    if "eof" in normalized or "broken pipe" in normalized:
        return "节点服务器提前断开连接"
    if "network is unreachable" in normalized:
        return "节点服务器网络不可达"
    return "Mihomo 节点连接失败"


def _safe_exception_error(exc: Exception) -> str:
    if isinstance(exc, MihomoError):
        return _summarize_mihomo_error(str(exc))
    return f"节点采集失败（{exc.__class__.__name__}）"


def _merge_error(*messages: str | None) -> str:
    parts = [" ".join(message.split()) for message in messages if message]
    return "；".join(dict.fromkeys(parts))[:2000]


def _remove_work_dir(work_dir: Path) -> bool:
    try:
        shutil.rmtree(work_dir)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return not work_dir.exists()


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _safe_job_error(exc: Exception) -> str:
    if isinstance(exc, (SubscriptionError, ResultStoreError)):
        return _short_error(exc)
    if isinstance(exc, MihomoError):
        return _summarize_mihomo_error(str(exc))
    return f"扫描任务失败（{exc.__class__.__name__}）"


def _short_error(exc: Exception) -> str:
    return " ".join(str(exc).split())[:1000] or exc.__class__.__name__


# Imported by FastAPI at module scope; one manager owns all active tasks.
job_manager = ScanJobManager()
