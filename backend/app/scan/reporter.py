"""扫描进行中的进度回报：runner → Worker 的 `/api/scan-progress`。

GitHub 在 job 结束前读不到日志，页面在扫描期间只能看到步骤名；这里每隔几秒把「已完成几个
节点、各几个成功/部分/失败」报给 Worker，页面轮询时一并取回。

三条硬约束：
- 只报计数与阶段。节点名、出口 IP、订阅内容一律不出 runner——它们只在终态 artifact 里，
  而 artifact 要经过脱敏与逐字节校验；
- 尽力而为。任何失败（网络、4xx/5xx、超时）只记一笔，绝不抛出、绝不拖住扫描；
- 报告的身份是 request_id + run_id + run_attempt，Worker 只把与当前运行对得上的那条交给页面。
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

PROGRESS_PATH = "/api/scan-progress"
_REPORT_INTERVAL_SECONDS = 2.0
# 没有变化时也隔一阵报一次：Worker 侧只存最新一条，心跳只是让「更新时间」不显得卡住。
_HEARTBEAT_SECONDS = 15.0
_REQUEST_TIMEOUT_SECONDS = 4.0
_PHASES = ("subscription", "scanning", "packaging", "done")


def progress_url_from_relay(relay_url: str) -> str:
    """进度端点与订阅中继同属一个 Worker：取中继地址的 origin，换上进度路径。"""

    parts = urlsplit(relay_url)
    return urlunsplit((parts.scheme, parts.netloc, PROGRESS_PATH, "", ""))


def job_counts(job: dict[str, Any] | None) -> dict[str, int]:
    """从扫描任务的内存状态取一份自洽的计数（完成数 = 三种状态之和，且不超过总数）。"""

    job = job or {}
    success = int(job.get("success_count") or 0)
    partial = int(job.get("partial_count") or 0)
    failed = int(job.get("failed_count") or 0)
    completed = success + partial + failed
    total = max(int(job.get("total") or 0), completed)
    return {
        "total": total,
        "completed": completed,
        "success": success,
        "partial": partial,
        "failed": failed,
    }


def phase_of(job: dict[str, Any] | None) -> str:
    status = (job or {}).get("status")
    if status == "running":
        return "scanning"
    if status == "completed":
        return "packaging"
    return "subscription"


class ProgressReporter:
    def __init__(
        self,
        url: str,
        token: str,
        *,
        request_id: str,
        run_id: int,
        run_attempt: int,
        client_factory: Callable[..., Any] = httpx.AsyncClient,
    ) -> None:
        self.url = url
        self.token = token
        self.identity = {
            "request_id": request_id,
            "run_id": run_id,
            "run_attempt": run_attempt,
        }
        self.client_factory = client_factory
        self.sent = 0
        self.failed = 0
        self._last: tuple[Any, ...] | None = None
        self._client: Any = None

    async def __aenter__(self) -> ProgressReporter:
        self._client = self.client_factory(
            timeout=_REQUEST_TIMEOUT_SECONDS,
            follow_redirects=False,
            trust_env=False,
        )
        return self

    async def __aexit__(self, *_exc: object) -> None:
        client, self._client = self._client, None
        if client is not None:
            with contextlib.suppress(Exception):
                await client.aclose()

    async def report(self, phase: str, counts: dict[str, int] | None = None) -> bool:
        if phase not in _PHASES or self._client is None:
            return False
        counts = counts or job_counts(None)
        payload = {**self.identity, "phase": phase, **counts}
        try:
            response = await self._client.post(
                self.url,
                json=payload,
                headers={"X-Best-IP-Relay-Token": self.token},
            )
            ok = response.status_code == 204
        except Exception:
            ok = False
        if ok:
            self.sent += 1
            self._last = (phase, *counts.values())
        else:
            self.failed += 1
        return ok

    async def follow(self, read_job: Callable[[], dict[str, Any] | None]) -> None:
        """跟着扫描任务的内存状态报数，直到被取消；只在读数变化或心跳到期时发送。"""

        loop = asyncio.get_running_loop()
        last_sent_at = 0.0
        while True:
            job = read_job()
            phase = phase_of(job)
            counts = job_counts(job)
            snapshot = (phase, *counts.values())
            now = loop.time()
            if snapshot != self._last or now - last_sent_at >= _HEARTBEAT_SECONDS:
                await self.report(phase, counts)
                last_sent_at = loop.time()
            await asyncio.sleep(_REPORT_INTERVAL_SECONDS)
