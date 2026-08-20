from __future__ import annotations

import asyncio
import copy
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .config import JOBS_DIR, RESULTS_DIR, Settings, settings
from .mihomo import MihomoError, MihomoProcess
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


class ScanJobManager:
    def __init__(self, app_settings: Settings = settings) -> None:
        self.settings = app_settings
        self.jobs: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self._semaphore = asyncio.Semaphore(app_settings.max_parallel_jobs)
        self.node_parallelism = app_settings.max_parallel_nodes

    def create(self, subscription_url: str) -> dict[str, str]:
        job_id = uuid4().hex
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
            "execution_mode": "parallel" if self.node_parallelism > 1 else "sequential",
            "error": None,
        }
        self.tasks[job_id] = asyncio.create_task(self._run(job_id, subscription_url))
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
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if job.get("status") == "queued":
            job["status"] = "cancelled"
            job["message"] = "扫描已取消"
            job["finished_at"] = _now()
        return self.get(job_id)

    async def shutdown(self) -> None:
        active = [task for task in self.tasks.values() if not task.done()]
        for task in active:
            task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)

    async def _run(self, job_id: str, subscription_url: str) -> None:
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
                except BaseException:
                    for task in node_tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*node_tasks, return_exceptions=True)
                    raise

                job["current_node"] = None
                job["finished_at"] = _now()
                result_store.finalize(job_id, job)
                job["status"] = "completed"
                job["manifest_ready"] = True
                suffix = f"，已跳过 {job['skipped']} 个订阅信息项" if job["skipped"] else ""
                job["message"] = f"扫描完成，共 {len(proxies)} 个节点{suffix}"
                await self._write_progress(job)
        except asyncio.CancelledError:
            job["status"] = "cancelled"
            job["message"] = "扫描已取消"
            job["current_node"] = None
            job["finished_at"] = _now()
            await self._safe_write_progress(job)
        except Exception as exc:
            job["status"] = "failed"
            job["message"] = "扫描任务失败"
            job["current_node"] = None
            job["finished_at"] = _now()
            job["error"] = _short_error(exc)
            await self._safe_write_progress(job)
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
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
                result = await collector.collect(
                    job_id=job["id"],
                    node_index=index,
                    node_name=node_name,
                    node_type=node_type,
                    selected_proxy=selected,
                    mihomo_instance=mihomo.instance_id,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                mihomo_error = mihomo.read_log_since(log_offset)
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
                    shutil.rmtree(mihomo.work_dir, ignore_errors=True)

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
    error = _merge_error(
        _short_error(exc),
        _summarize_mihomo_error(mihomo_error) if mihomo_error else None,
    )
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
        "transport_error": error,
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
    if "dns resolve failed" in message:
        return "节点服务器域名无法解析"
    if "REALITY authentication failed" in message:
        return "节点 REALITY 认证失败"
    if "context deadline exceeded" in message:
        return "连接节点服务器超时"
    if "connection refused" in message:
        return "节点服务器拒绝连接"
    return "Mihomo 节点连接失败"


def _merge_error(*messages: str | None) -> str:
    parts = [" ".join(message.split()) for message in messages if message]
    return "；".join(dict.fromkeys(parts))[:2000]


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _short_error(exc: Exception) -> str:
    return " ".join(str(exc).split())[:1000] or exc.__class__.__name__


# Imported by FastAPI at module scope; one manager owns all active tasks.
job_manager = ScanJobManager()
