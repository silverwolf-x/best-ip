from __future__ import annotations

import asyncio
import copy
import shutil
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from .config import JOBS_DIR, Settings, settings
from .mihomo import MihomoProcess
from .scanner import HttpScanner
from .subscription import download_subscription, parse_subscription


class JobNotFoundError(KeyError):
    pass


class ScanJobManager:
    def __init__(self, app_settings: Settings = settings) -> None:
        self.settings = app_settings
        self.jobs: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self._semaphore = asyncio.Semaphore(app_settings.max_parallel_jobs)

    def create(self, subscription_url: str) -> dict[str, str]:
        job_id = uuid4().hex
        self.jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "message": "等待扫描资源",
            "created_at": _now(),
            "finished_at": None,
            "total": 0,
            "completed": 0,
            "current_node": None,
            "results": [],
            "error": None,
        }
        self.tasks[job_id] = asyncio.create_task(self._run(job_id, subscription_url))
        return {"id": job_id, "status": "queued"}

    def get(self, job_id: str, *, include_details: bool = False) -> dict[str, Any]:
        job = self.jobs.get(job_id)
        if job is None:
            raise JobNotFoundError(job_id)
        snapshot = copy.deepcopy(job)
        if not include_details:
            snapshot["results"] = [
                {key: value for key, value in result.items() if key != "pages"}
                for result in snapshot["results"]
            ]
        return snapshot

    def get_result(self, job_id: str, index: int) -> dict[str, Any]:
        job = self.jobs.get(job_id)
        if job is None or index < 0 or index >= len(job["results"]):
            raise JobNotFoundError(job_id)
        return copy.deepcopy(job["results"][index])

    async def cancel(self, job_id: str) -> dict[str, Any]:
        job = self.jobs.get(job_id)
        if job is None:
            raise JobNotFoundError(job_id)
        task = self.tasks.get(job_id)
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
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
        mihomo: MihomoProcess | None = None
        try:
            async with self._semaphore:
                job["status"] = "preparing"
                job["message"] = "正在安全下载并解析订阅"
                content = await download_subscription(
                    subscription_url,
                    max_bytes=self.settings.subscription_max_bytes,
                    timeout_seconds=self.settings.subscription_timeout_seconds,
                )
                proxies = parse_subscription(content, max_nodes=self.settings.max_nodes)
                job["total"] = len(proxies)

                mihomo = MihomoProcess(self.settings.mihomo_path, work_dir, proxies)
                job["message"] = "正在启动工作区 Mihomo 核心"
                await mihomo.start()
                scanner = HttpScanner(mihomo.proxy_url, timeout_ms=self.settings.page_timeout_ms)
                job["status"] = "running"

                for index, proxy in enumerate(proxies, start=1):
                    node_name = str(proxy["name"])
                    node_type = str(proxy["type"])
                    job["current_node"] = node_name
                    job["message"] = f"正在检测 {index}/{len(proxies)}：{node_name}"
                    try:
                        await mihomo.select(node_name)
                        result = await scanner.scan_node(node_name, node_type)
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        result = _failed_node(node_name, node_type, exc)
                    job["results"].append(result)
                    job["completed"] = index

                job["status"] = "completed"
                job["message"] = f"扫描完成，共 {len(proxies)} 个节点"
                job["current_node"] = None
        except asyncio.CancelledError:
            job["status"] = "cancelled"
            job["message"] = "扫描已取消"
            job["current_node"] = None
        except Exception as exc:
            job["status"] = "failed"
            job["message"] = "扫描任务失败"
            job["current_node"] = None
            job["error"] = _short_error(exc)
        finally:
            if mihomo:
                await mihomo.stop()
            shutil.rmtree(work_dir, ignore_errors=True)
            job["finished_at"] = _now()


def _failed_node(node_name: str, node_type: str, exc: Exception) -> dict[str, Any]:
    return {
        "node": node_name,
        "type": node_type,
        "status": "failed",
        "exit_ip": "",
        "cidr": "",
        "rdns": "",
        "ai_verdict": "",
        "egress_ips": {"cf": "", "gpt": "", "claude": ""},
        "location": "",
        "score": None,
        "gpt_access": "",
        "claude_access": "",
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
        "elapsed_ms": 0,
        "pages": {},
        "error": _short_error(exc),
    }


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _short_error(exc: Exception) -> str:
    return " ".join(str(exc).split())[:1000] or exc.__class__.__name__


job_manager = ScanJobManager()
