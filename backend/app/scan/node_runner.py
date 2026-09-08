from __future__ import annotations

import asyncio
import ipaddress
import shutil
from collections.abc import Callable
from pathlib import Path
from time import perf_counter
from typing import Any

from ..async_utils import to_thread_uncancelled as _to_thread_uncancelled
from ..config import Settings
from ..mihomo import MihomoError, MihomoNotReadyError, MihomoProcess, MihomoStopError
from ..sources.collector import CoffeeCollector
from .errors import (
    ScanError,
    _attach_mihomo_error,
    _failed_node,
    _read_mihomo_error,
    classify_error,
)
from .models import NodeOutcome, NodeRecord


class NodeRunner:
    def __init__(
        self,
        app_settings: Settings,
        *,
        mihomo_factory: Callable[..., Any] = MihomoProcess,
        collector_factory: Callable[..., Any] = CoffeeCollector,
    ) -> None:
        self.settings = app_settings
        self.mihomo_factory = mihomo_factory
        self.collector_factory = collector_factory

    async def run(
        self,
        *,
        job_id: str,
        work_dir: Path,
        proxies: list[dict[str, Any]],
        proxy: dict[str, Any],
        index: int,
        dns_bootstrap_candidates: list[str],
        outbound_interface: str | None,
        on_attempt: Callable[[int], None] | None = None,
    ) -> NodeOutcome:
        phase_ms: dict[str, int] = {}
        failure: ScanError | None = None
        node_name = str(proxy["name"])
        node_type = str(proxy["type"])
        attempt_errors: list[str] = []
        result: NodeRecord | None = None
        final_mihomo: MihomoProcess | None = None
        attempts_used = 0
        last_dns_bootstrap_proxy: str | None = None
        proxy_by_name = {str(candidate.get("name") or ""): candidate for candidate in proxies}

        for attempt in range(1, self.settings.max_node_attempts + 1):
            attempts_used = attempt
            mihomo: MihomoProcess | None = None
            log_offset = 0
            failure_phase = "start"
            failure = None
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
                mihomo = self.mihomo_factory(
                    self.settings.mihomo_path,
                    work_dir / f"node-{index:04d}-attempt-{attempt:02d}",
                    attempt_proxies,
                    selector_names=[node_name],
                    outbound_interface=outbound_interface,
                    dns_bootstrap_proxy=dns_bootstrap_proxy,
                )
                final_mihomo = mihomo
                if on_attempt:
                    on_attempt(attempt)
                phase_started = perf_counter()
                try:
                    await mihomo.start()
                finally:
                    _record_phase(phase_ms, "start", phase_started)
                log_offset = mihomo.log_offset()
                failure_phase = "selector"
                phase_started = perf_counter()
                try:
                    selected = await mihomo.select(node_name)
                    if selected != node_name:
                        raise MihomoError("切换节点后未确认 selector 身份")
                finally:
                    _record_phase(phase_ms, "select", phase_started)
                failure_phase = "collector"
                collector = self.collector_factory(
                    mihomo.proxy_url,
                    timeout_ms=self.settings.page_timeout_ms,
                )
                phase_started = perf_counter()
                try:
                    result = await asyncio.wait_for(
                        collector.collect(
                            job_id=job_id,
                            node_index=index,
                            node_name=node_name,
                            node_type=node_type,
                            selected_proxy=selected,
                            mihomo_instance=mihomo.instance_id,
                        ),
                        timeout=self.settings.page_timeout_ms / 1000,
                    )
                finally:
                    _record_phase(phase_ms, "collect", phase_started)
                _attach_mihomo_error(result, mihomo, log_offset)
            except asyncio.CancelledError:
                raise
            except MihomoNotReadyError:
                raise
            except MihomoStopError:
                raise
            except Exception as exc:
                failure = classify_error(exc, phase=failure_phase)
                mihomo_error = _read_mihomo_error(mihomo, log_offset) if mihomo else ""
                result = _failed_node(
                    job_id,
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
                        await _cleanup_mihomo(mihomo, work_dir)
                    finally:
                        _record_phase(phase_ms, "stop", phase_started)

            if result.get("status") != "failed":
                break
            attempt_errors.append(_attempt_error(result))
            if (
                failure is not None and not failure.retryable
            ) or attempt >= self.settings.max_node_attempts:
                break
            if self.settings.node_retry_backoff_ms:
                await asyncio.sleep(self.settings.node_retry_backoff_ms * attempt / 1000)

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
        if result.get("status") == "success":
            failure = None
        elif failure is None:
            failure = ScanError(
                "node_transport" if result.get("status") == "failed" else "enrichment_unavailable",
                "collect",
                result.get("status") == "failed",
                "节点传输连接失败" if result.get("status") == "failed" else "节点采集不完整",
            )
        return NodeOutcome(result, phase_ms, failure)


async def _cleanup_mihomo(mihomo: Any, work_dir: Path) -> None:
    async def cleanup() -> None:
        try:
            await mihomo.stop()
            if not await _to_thread_uncancelled(_remove_work_dir, mihomo.work_dir, work_dir):
                raise MihomoStopError("Mihomo 工作目录清理未确认")
        except asyncio.CancelledError:
            raise MihomoStopError("Mihomo 清理任务被取消") from None
        except MihomoStopError:
            raise
        except Exception as exc:
            raise MihomoStopError("Mihomo 进程或工作目录清理未确认") from exc

    operation = asyncio.create_task(cleanup())
    cancelled = False
    while True:
        try:
            await asyncio.shield(operation)
            break
        except asyncio.CancelledError:
            if operation.cancelled():
                raise MihomoStopError("Mihomo 清理任务被取消") from None
            cancelled = True
    if cancelled:
        raise asyncio.CancelledError


def _record_phase(phase_ms: dict[str, int], phase: str, started: float) -> None:
    phase_ms[phase] = phase_ms.get(phase, 0) + round((perf_counter() - started) * 1000)


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
            "outbound_interface": (mihomo.outbound_interface if mihomo else outbound_interface),
            "dns_bootstrap_proxy": (mihomo.dns_bootstrap_proxy if mihomo else dns_bootstrap_proxy),
            "fresh_mihomo_per_attempt": True,
            "max_attempts": max_attempts,
        }
    )


def _remove_work_dir(work_dir: Path, workspace: Path) -> bool:
    target = work_dir.resolve()
    root = workspace.resolve()
    if not target.is_relative_to(root) or target == root:
        raise ValueError("工作目录不在扫描工作区中")
    try:
        shutil.rmtree(target)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return not target.exists()
