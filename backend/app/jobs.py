from __future__ import annotations

import asyncio
import copy
import hashlib
import ipaddress
import shutil
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter
from typing import Any
from uuid import uuid4

from .config import JOBS_DIR, Settings, settings
from .mihomo import (
    MIHOMO_NOT_READY_MESSAGE,
    MihomoError,
    MihomoNotReadyError,
    MihomoProcess,
    MihomoStopError,
    resolve_outbound_interface,
)
from .result_store import ResultStoreError, result_store
from .scanner import CoffeeCollector
from .subscription import (
    SubscriptionError,
    download_subscription,
    is_subscription_metadata,
    parse_subscription,
)


class JobNotFoundError(KeyError):
    pass


class JobNotReadyError(RuntimeError):
    pass


class JobAlreadyExistsError(RuntimeError):
    pass


_PROGRESS_WRITE_INTERVAL_SECONDS = 0.2


async def _to_thread_uncancelled(function: Any, *args: Any, **kwargs: Any) -> Any:
    operation = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(operation)
    except asyncio.CancelledError:
        with suppress(BaseException):
            await asyncio.shield(operation)
        raise


class ScanJobManager:
    def __init__(self, app_settings: Settings = settings) -> None:
        self.settings = app_settings
        self.jobs: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self._summaries: dict[str, dict[int, dict[str, Any]]] = {}
        self._progress_locks: dict[str, asyncio.Lock] = {}
        self._progress_last_write: dict[str, float] = {}
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
        if not self.settings.mihomo_path.is_file():
            raise MihomoNotReadyError(MIHOMO_NOT_READY_MESSAGE)
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
            "metrics": {
                "configured_node_parallelism": self.node_parallelism,
                "active_nodes": 0,
                "peak_active_nodes": 0,
                "wall_ms": None,
                "phase_ms": {
                    "prepare": 0,
                    "start": 0,
                    "select": 0,
                    "collect": 0,
                    "stop": 0,
                    "write": 0,
                    "finalize": 0,
                },
            },
        }
        self._summaries[job_id] = {}
        self._progress_locks[job_id] = asyncio.Lock()
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
            completed = job.get("completed", 0)
            cached = self._summaries.get(job_id)
            if cached is not None:
                snapshot["results"] = [
                    copy.deepcopy(cached[index]) for index in sorted(cached)
                ]
                if len(snapshot["results"]) != completed:
                    snapshot["error"] = "节点摘要缓存与完成计数不一致"
                    snapshot["results"] = []
            elif isinstance(completed, int) and completed > 0:
                try:
                    snapshot["results"] = result_store.read_available_summaries(
                        job_id,
                        expected_count=completed,
                    )
                except ResultStoreError as exc:
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
        return await _to_thread_uncancelled(self.get, job_id)

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
        wall_started = perf_counter()
        work_dir = JOBS_DIR / job_id
        try:
            async with self._semaphore:
                job["status"] = "preparing"
                job["message"] = "正在安全下载并解析订阅"
                prepare_started = perf_counter()
                try:
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
                    outbound_interface = await _to_thread_uncancelled(
                        resolve_outbound_interface,
                        self.settings.outbound_interface,
                    )
                    parsed_proxies = await _to_thread_uncancelled(
                        parse_subscription,
                        content,
                        max_nodes=self.settings.max_nodes,
                    )
                    proxies = [
                        proxy
                        for proxy in parsed_proxies
                        if not is_subscription_metadata(proxy)
                    ]
                    dns_bootstrap_candidates = _dns_bootstrap_candidates(proxies)
                    job["skipped"] = len(parsed_proxies) - len(proxies)
                    if not proxies:
                        raise SubscriptionError("订阅中没有可检测的代理节点")
                    job["total"] = len(proxies)
                    await _to_thread_uncancelled(
                        result_store.initialize,
                        job_id,
                        _progress(job),
                    )
                    self._progress_last_write[job_id] = asyncio.get_running_loop().time()
                finally:
                    _record_phase(job, "prepare", prepare_started)

                job["status"] = "running"
                job["message"] = f"正在并行检测 {len(proxies)} 个节点"
                job["cleanup_confirmed"] = False
                await self._write_progress(job)
                node_queue: asyncio.Queue[tuple[int, dict[str, Any]]] = asyncio.Queue()
                for index, proxy in enumerate(proxies):
                    node_queue.put_nowait((index, proxy))

                async def node_worker() -> None:
                    while True:
                        try:
                            index, proxy = node_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            return
                        try:
                            await self._scan_node(
                                job,
                                work_dir,
                                proxies,
                                proxy,
                                index,
                                dns_bootstrap_candidates,
                                outbound_interface,
                            )
                        finally:
                            node_queue.task_done()

                worker_count = min(self.node_parallelism, len(proxies))
                node_tasks = [
                    asyncio.create_task(node_worker()) for _ in range(worker_count)
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
                if not await _to_thread_uncancelled(_remove_work_dir, work_dir):
                    job["cleanup_confirmed"] = False
                    raise OSError("Mihomo 工作目录清理失败")

                job["current_node"] = None
                job["finished_at"] = _now()
                finalize_started = perf_counter()
                try:
                    await _to_thread_uncancelled(result_store.finalize, job_id, job)
                finally:
                    _record_phase(job, "finalize", finalize_started)
                job["status"] = "completed"
                job["manifest_ready"] = True
                suffix = f"，已跳过 {job['skipped']} 个订阅信息项" if job["skipped"] else ""
                job["message"] = f"扫描完成，共 {len(proxies)} 个节点{suffix}"
                await self._safe_write_progress(job)
        except asyncio.CancelledError:
            work_dir_removed = await _to_thread_uncancelled(_remove_work_dir, work_dir)
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
            work_dir_removed = await _to_thread_uncancelled(_remove_work_dir, work_dir)
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
            metrics = job.get("metrics")
            if isinstance(metrics, dict):
                metrics["wall_ms"] = round((perf_counter() - wall_started) * 1000)

    async def _scan_node(
        self,
        job: dict[str, Any],
        work_dir: Path,
        proxies: list[dict[str, Any]],
        proxy: dict[str, Any],
        index: int,
        dns_bootstrap_candidates: list[str],
        outbound_interface: str | None,
    ) -> None:
        metrics = job.get("metrics")
        if isinstance(metrics, dict):
            metrics["active_nodes"] = int(metrics.get("active_nodes") or 0) + 1
            metrics["peak_active_nodes"] = max(
                int(metrics.get("peak_active_nodes") or 0),
                metrics["active_nodes"],
            )
        try:
            node_name = str(proxy["name"])
            node_type = str(proxy["type"])
            attempt_errors: list[str] = []
            result: dict[str, Any] | None = None
            final_mihomo: MihomoProcess | None = None
            attempts_used = 0
            last_dns_bootstrap_proxy: str | None = None
            proxy_by_name = {
                str(candidate.get("name") or ""): candidate for candidate in proxies
            }

            for attempt in range(1, self.settings.max_node_attempts + 1):
                attempts_used = attempt
                mihomo: MihomoProcess | None = None
                log_offset = 0
                failure_phase = "start"
                try:
                    dns_bootstrap_proxy = _dns_bootstrap_for_attempt(
                        proxy,
                        dns_bootstrap_candidates,
                        proxy_by_name=proxy_by_name,
                        node_index=index,
                        attempt=attempt,
                    )
                    last_dns_bootstrap_proxy = dns_bootstrap_proxy
                    attempt_proxies = _attempt_proxies(
                        proxy,
                        proxy_by_name,
                        dns_bootstrap_proxy=dns_bootstrap_proxy,
                    )
                    mihomo = MihomoProcess(
                        self.settings.mihomo_path,
                        work_dir / f"node-{index:04d}-attempt-{attempt:02d}",
                        attempt_proxies,
                        selector_names=[node_name],
                        outbound_interface=outbound_interface,
                        dns_bootstrap_proxy=dns_bootstrap_proxy,
                    )
                    final_mihomo = mihomo
                    job["message"] = (
                        f"正在并行检测 {index + 1}/{job['total']}：{node_name}，"
                        f"尝试 {attempt}/{self.settings.max_node_attempts}"
                    )
                    phase_started = perf_counter()
                    try:
                        await mihomo.start()
                    finally:
                        _record_phase(job, "start", phase_started)
                    log_offset = mihomo.log_offset()
                    failure_phase = "selector"
                    phase_started = perf_counter()
                    try:
                        selected = await mihomo.select(node_name)
                    finally:
                        _record_phase(job, "select", phase_started)
                    collector = CoffeeCollector(
                        mihomo.proxy_url,
                        timeout_ms=self.settings.page_timeout_ms,
                    )
                    failure_phase = "collector"
                    phase_started = perf_counter()
                    try:
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
                    finally:
                        _record_phase(job, "collect", phase_started)
                    _attach_mihomo_error(result, mihomo, log_offset)
                except asyncio.CancelledError:
                    raise
                except MihomoNotReadyError:
                    raise
                except Exception as exc:
                    mihomo_error = (
                        _read_mihomo_error(mihomo, log_offset) if mihomo else ""
                    )
                    result = _failed_node(
                        job["id"],
                        index,
                        node_name,
                        node_type,
                        exc,
                        phase=failure_phase,
                        mihomo_error=mihomo_error,
                        mihomo=mihomo,
                    )
                finally:
                    if mihomo:
                        phase_started = perf_counter()
                        try:
                            await mihomo.stop()
                        finally:
                            _record_phase(job, "stop", phase_started)
                        if not await _to_thread_uncancelled(
                            _remove_work_dir, mihomo.work_dir
                        ):
                            raise MihomoStopError("Mihomo 工作目录清理未确认")

                if result.get("status") != "failed":
                    break
                attempt_errors.append(_attempt_error(result))
                if attempt >= self.settings.max_node_attempts:
                    break
                if self.settings.node_retry_backoff_ms:
                    await asyncio.sleep(
                        self.settings.node_retry_backoff_ms * attempt / 1000
                    )

            if result is None:
                raise RuntimeError("节点扫描没有产生终态记录")
            _attach_attempt_evidence(
                result,
                attempts_used=attempts_used,
                max_attempts=self.settings.max_node_attempts,
                attempt_errors=attempt_errors,
                mihomo=final_mihomo,
                outbound_interface=outbound_interface,
                dns_bootstrap_proxy=last_dns_bootstrap_proxy,
            )
            phase_started = perf_counter()
            try:
                await _to_thread_uncancelled(
                    result_store.write_node,
                    job["id"],
                    index,
                    result,
                )
            finally:
                _record_phase(job, "write", phase_started)
            self._summaries.setdefault(job["id"], {})[index] = result_store.summary(result)
            _count_result(job, result)
            job["completed"] += 1
            await self._write_progress(job)
        finally:
            if isinstance(metrics, dict):
                metrics["active_nodes"] = max(
                    0,
                    int(metrics.get("active_nodes") or 0) - 1,
                )

    async def _write_progress(self, job: dict[str, Any], *, force: bool = False) -> None:
        job_id = job["id"]
        lock = self._progress_locks.setdefault(job_id, asyncio.Lock())
        async with lock:
            now = asyncio.get_running_loop().time()
            last_write = self._progress_last_write.get(job_id)
            if (
                not force
                and last_write is not None
                and now - last_write < _PROGRESS_WRITE_INTERVAL_SECONDS
            ):
                return
            await _to_thread_uncancelled(result_store.write_progress, job_id, _progress(job))
            self._progress_last_write[job_id] = asyncio.get_running_loop().time()

    async def _safe_write_progress(self, job: dict[str, Any]) -> None:
        try:
            if (result_store.root / job["id"]).exists():
                await self._write_progress(job, force=True)
        except (OSError, ResultStoreError):
            pass


def _record_phase(job: dict[str, Any], phase: str, started: float) -> None:
    metrics = job.get("metrics")
    phase_ms = metrics.get("phase_ms") if isinstance(metrics, dict) else None
    if not isinstance(phase_ms, dict) or phase not in phase_ms:
        return
    phase_ms[phase] = int(phase_ms[phase]) + round((perf_counter() - started) * 1000)


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


def _dns_bootstrap_candidates(proxies: list[dict[str, Any]]) -> list[str]:
    candidates: list[str] = []
    for proxy in proxies:
        try:
            address = ipaddress.ip_address(str(proxy.get("server") or ""))
        except ValueError:
            continue
        name = str(proxy.get("name") or "")
        if address.is_global and name:
            candidates.append(name)
    return list(dict.fromkeys(candidates))


def _dns_bootstrap_for_attempt(
    proxy: dict[str, Any],
    candidates: list[str],
    *,
    proxy_by_name: dict[str, dict[str, Any]] | None = None,
    node_index: int,
    attempt: int,
) -> str | None:
    if not candidates:
        return None
    if _proxy_chain_requires_dns(proxy, proxy_by_name or {}):
        return candidates[(node_index + attempt - 1) % len(candidates)]
    return None


def _proxy_chain_requires_dns(
    proxy: dict[str, Any],
    proxy_by_name: dict[str, dict[str, Any]],
    visited: set[str] | None = None,
) -> bool:
    try:
        ipaddress.ip_address(str(proxy.get("server") or ""))
    except ValueError:
        return True

    dependency_name = proxy.get("dialer-proxy")
    if not isinstance(dependency_name, str) or not dependency_name:
        return False
    seen = set() if visited is None else visited
    if dependency_name in seen:
        return False
    dependency = proxy_by_name.get(dependency_name)
    if dependency is None:
        return False
    seen.add(dependency_name)
    return _proxy_chain_requires_dns(dependency, proxy_by_name, seen)


def _attempt_proxies(
    proxy: dict[str, Any],
    proxy_by_name: dict[str, dict[str, Any]],
    *,
    dns_bootstrap_proxy: str | None,
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    included_names: set[str] = set()

    def include(candidate: dict[str, Any]) -> None:
        name = str(candidate.get("name") or "")
        if not name or name in included_names:
            return
        included_names.add(name)
        selected.append(candidate)
        dependency_name = candidate.get("dialer-proxy")
        if not isinstance(dependency_name, str) or not dependency_name:
            return
        dependency = proxy_by_name.get(dependency_name)
        if dependency is not None:
            include(dependency)

    include(proxy)
    if dns_bootstrap_proxy:
        bootstrap = proxy_by_name.get(dns_bootstrap_proxy)
        if bootstrap is None:
            raise MihomoError("DNS 引导节点不在当前订阅代理集合中")
        include(bootstrap)
    return selected


def _attempt_error(result: dict[str, Any]) -> str:
    error = str(result.get("transport_error") or result.get("error") or "节点检测失败")
    return " ".join(error.split())[:500]


def _attach_attempt_evidence(
    result: dict[str, Any],
    *,
    attempts_used: int,
    max_attempts: int,
    attempt_errors: list[str],
    mihomo: MihomoProcess | None,
    outbound_interface: str | None,
    dns_bootstrap_proxy: str | None,
) -> None:
    result["attempt_count"] = attempts_used
    result["retry_count"] = attempts_used - 1
    result["attempt_errors"] = list(attempt_errors)
    evidence = result.get("proxy_evidence")
    if not isinstance(evidence, dict):
        evidence = {}
        result["proxy_evidence"] = evidence
    evidence.update(
        {
            "outbound_interface": (
                mihomo.outbound_interface if mihomo else outbound_interface
            ),
            "dns_bootstrap_proxy": (
                mihomo.dns_bootstrap_proxy if mihomo else dns_bootstrap_proxy
            ),
            "fresh_mihomo_per_attempt": True,
            "max_attempts": max_attempts,
        }
    )


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
    phase: str | None = None,
    mihomo_error: str = "",
    mihomo: MihomoProcess | None = None,
) -> dict[str, Any]:
    exception_error = _safe_exception_error(exc)
    transport_error = exception_error
    if mihomo_error and exception_error == "Mihomo 节点连接失败":
        transport_error = _summarize_mihomo_error(mihomo_error)
    error = transport_error
    return {
        "schema_version": 1,
        "job_id": job_id,
        "node_index": index,
        "node": node_name,
        "type": node_type,
        "status": "failed",
        "error": error,
        "phase": phase or ("selector" if isinstance(exc, MihomoError) else "collector"),
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
        "requests": {"gpt_check": []},
        "coffee": {"gpt_check": []},
        "completeness": {
            "complete": False,
            "required": {"page": False, "trace": False, "lookup": False},
            "optional": {},
            "missing": ["selector_or_collector"],
        },
        "transport_error": transport_error,
        "cidr": "",
        "rdns": "-",
        "ai_verdict": "",
        "location": "",
        "isp": "",
        "score": None,
        "is_residential": None,
        "is_datacenter": None,
        "is_native": None,
        "native_status": "未知",
        "native_detail": "",
        "is_bogon": False,
        "bogon_status": "未知",
        "bogon_reason": "",
        "rpki_status": "未知",
        "asn_kind": "",
        "asn_kind_display": "未知",
        "abuse_level": "未知",
        "honeypot_status": "未知",
        "traffic_profile": "未知",
        "company_type": "未知",
        "is_vpn": None,
        "is_proxy": None,
        "is_tor": None,
        "is_crawler": None,
        "is_abuser": None,
        "security_status": "检测失败",
        "threat_tags": [],
        "asn": None,
        "as_org": "",
        "global_ping": [],
        "port_scan": None,
        "ping_check": None,
        "gpt_check": [],
        "related_domains": [],
        "elapsed_ms": 0,
    }


def _summarize_mihomo_error(message: str) -> str:
    normalized = message.lower()
    if "parse config error" in normalized or "unsupport proxy type" in normalized:
        return "Mihomo 节点配置不受支持"
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
        message = str(exc)
        prefix = "切换节点失败：HTTP "
        if message.startswith(prefix):
            status_code = message.removeprefix(prefix).strip()
            if status_code.isdigit():
                return f"Mihomo selector 切换失败（HTTP {status_code}）"
        if message.startswith("切换节点后未确认 selector 身份"):
            return "Mihomo selector 未确认所选节点"
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
    if isinstance(exc, MihomoNotReadyError):
        return str(exc)
    if isinstance(exc, MihomoError):
        return _summarize_mihomo_error(str(exc))
    return f"扫描任务失败（{exc.__class__.__name__}）"


def _short_error(exc: Exception) -> str:
    return " ".join(str(exc).split())[:1000] or exc.__class__.__name__


# Imported by FastAPI at module scope; one manager owns all active tasks.
job_manager = ScanJobManager()
