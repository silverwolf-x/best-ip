from __future__ import annotations

import asyncio
import copy
import os
import secrets
import socket
import subprocess
from contextlib import suppress
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import yaml

COFFEE_HOST = "ip.net.coffee"
MIHOMO_NOT_READY_MESSAGE = (
    "Mihomo 核心未就绪，请运行 uv run python scripts/download_mihomo.py"
)


class MihomoError(RuntimeError):
    pass


class MihomoNotReadyError(MihomoError):
    pass


class MihomoStopError(MihomoError):
    pass


_DNS_GROUP_NAME = "BEST-IP-DNS"
_DOH_RESOLVERS = (
    "https://223.5.5.5/dns-query",
    "https://1.12.12.12/dns-query",
    "https://1.1.1.1/dns-query",
    "https://8.8.8.8/dns-query",
)
_DEFAULT_DNS_CONFIG = {
    "enable": True,
    "ipv6": False,
    "enhanced-mode": "redir-host",
    "default-nameserver": ["223.5.5.5", "119.29.29.29", "1.1.1.1", "8.8.8.8"],
    "nameserver": list(_DOH_RESOLVERS),
    "proxy-server-nameserver": list(_DOH_RESOLVERS),
    "respect-rules": False,
}
_MIHOMO_START_LOCK = asyncio.Lock()
_WINDOWS_INTERFACE_DISCOVERY_SCRIPT = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$interfaceMetrics = @{}
Get-NetIPInterface -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object {
    $interfaceMetrics[[int]$_.InterfaceIndex] = [int]$_.InterfaceMetric
}
$physicalAdapters = @{}
Get-NetAdapter -Physical -ErrorAction Stop |
    Where-Object { $_.Status -eq 'Up' } |
    ForEach-Object { $physicalAdapters[[int]$_.ifIndex] = [string]$_.Name }
$candidates = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' `
    -ErrorAction Stop | ForEach-Object {
        $index = [int]$_.ifIndex
        if ($physicalAdapters.ContainsKey($index)) {
            [PSCustomObject]@{
                Name = $physicalAdapters[$index]
                Metric = [int]$_.RouteMetric + [int]$interfaceMetrics[$index]
            }
        }
    }
$candidates | Sort-Object Metric | Select-Object -First 1 -ExpandProperty Name
"""


def _build_dns_config(*, use_bootstrap_proxy: bool) -> dict[str, Any]:
    config = copy.deepcopy(_DEFAULT_DNS_CONFIG)
    if use_bootstrap_proxy:
        resolvers = [f"{resolver}#{_DNS_GROUP_NAME}" for resolver in _DOH_RESOLVERS]
        config["nameserver"] = resolvers
        config["proxy-server-nameserver"] = list(resolvers)
    return config


def resolve_outbound_interface(configured: str | None) -> str | None:
    if configured is not None:
        return _validate_outbound_interface(configured)
    if os.name != "nt":
        return None

    kwargs: dict[str, Any] = {}
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if creationflags:
        kwargs["creationflags"] = creationflags
    try:
        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                _WINDOWS_INTERFACE_DISCOVERY_SCRIPT,
            ],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
            check=False,
            **kwargs,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise MihomoError(
            "无法自动检测独立物理出站网卡，请设置 BEST_IP_OUTBOUND_INTERFACE"
        ) from exc

    interface = next(
        (line.strip() for line in completed.stdout.splitlines() if line.strip()),
        "",
    )
    if completed.returncode != 0 or not interface:
        raise MihomoError(
            "无法自动检测独立物理出站网卡，请设置 BEST_IP_OUTBOUND_INTERFACE"
        )
    return _validate_outbound_interface(interface)


def _validate_outbound_interface(value: str) -> str:
    interface = value.strip()
    if (
        not interface
        or len(interface) > 256
        or any(ord(character) < 32 for character in interface)
    ):
        raise MihomoError("BEST_IP_OUTBOUND_INTERFACE 不是有效的网卡名称")
    return interface


class MihomoProcess:
    group_name = "BEST-IP"
    dns_group_name = _DNS_GROUP_NAME

    def __init__(
        self,
        core_path: Path,
        work_dir: Path,
        proxies: list[dict[str, Any]],
        *,
        selector_names: list[str] | None = None,
        outbound_interface: str | None = None,
        dns_bootstrap_proxy: str | None = None,
    ) -> None:
        self.core_path = core_path
        self.work_dir = work_dir
        self.proxies = proxies
        self.selector_names = selector_names or [str(proxy["name"]) for proxy in proxies]
        proxy_names = {str(proxy.get("name") or "") for proxy in proxies}
        if dns_bootstrap_proxy is not None and dns_bootstrap_proxy not in proxy_names:
            raise MihomoError("DNS 引导节点不在当前订阅代理集合中")
        self.dns_bootstrap_proxy = dns_bootstrap_proxy
        self.dns_config = _build_dns_config(
            use_bootstrap_proxy=dns_bootstrap_proxy is not None,
        )
        self.outbound_interface = (
            _validate_outbound_interface(outbound_interface)
            if outbound_interface is not None
            else None
        )
        self.mixed_port = self._free_port()
        self.controller_port = self._free_port()
        self.secret = secrets.token_urlsafe(24)
        self.instance_id = secrets.token_hex(8)
        self.process: asyncio.subprocess.Process | None = None
        self.log_path = self.work_dir / "mihomo.log"
        self._log_handle: Any = None

    @staticmethod
    def _free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    @property
    def proxy_url(self) -> str:
        return f"http://127.0.0.1:{self.mixed_port}"

    @property
    def controller_url(self) -> str:
        return f"http://127.0.0.1:{self.controller_port}"

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.secret}"}

    async def start(self) -> None:
        if not self.core_path.is_file():
            raise MihomoNotReadyError(MIHOMO_NOT_READY_MESSAGE)

        async with _MIHOMO_START_LOCK:
            self.mixed_port = self._free_port()
            self.controller_port = self._free_port()
            self.work_dir.mkdir(parents=True, exist_ok=False)
            config_path = self.work_dir / "config.yaml"
            proxy_groups = [
                {
                    "name": self.group_name,
                    "type": "select",
                    "proxies": self.selector_names,
                }
            ]
            if self.dns_bootstrap_proxy:
                proxy_groups.append(
                    {
                        "name": self.dns_group_name,
                        "type": "select",
                        "proxies": [self.dns_bootstrap_proxy],
                    }
                )
            config = {
                "mixed-port": self.mixed_port,
                "allow-lan": False,
                "bind-address": "127.0.0.1",
                "mode": "rule",
                "log-level": "warning",
                "ipv6": False,
                "external-controller": f"127.0.0.1:{self.controller_port}",
                "secret": self.secret,
                "profile": {"store-selected": False, "store-fake-ip": False},
                "dns": self.dns_config,
                "proxies": self.proxies,
                "proxy-groups": proxy_groups,
                "rules": [
                    f"DOMAIN,{COFFEE_HOST},{self.group_name}",
                    "MATCH,REJECT",
                ],
            }
            if self.outbound_interface:
                config["interface-name"] = self.outbound_interface
            config_path.write_text(
                yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8"
            )

            self._log_handle = self.log_path.open("w", encoding="utf-8")
            kwargs: dict[str, Any] = {}
            if os.name == "nt":
                kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
            self.process = await asyncio.create_subprocess_exec(
                str(self.core_path),
                "-d",
                str(self.work_dir),
                "-f",
                str(config_path),
                stdout=self._log_handle,
                stderr=subprocess.STDOUT,
                **kwargs,
            )

            try:
                await self._wait_until_ready()
            except BaseException as exc:
                try:
                    await self.stop()
                except MihomoStopError:
                    raise
                if isinstance(exc, asyncio.CancelledError):
                    raise
                detail = self._read_log_tail(self.log_path)
                suffix = f"：{detail}" if detail else ""
                raise MihomoError(f"Mihomo 启动失败{suffix}") from None

    async def _wait_until_ready(self) -> None:
        deadline = asyncio.get_running_loop().time() + 15
        async with httpx.AsyncClient(timeout=1, trust_env=False) as client:
            while asyncio.get_running_loop().time() < deadline:
                if self.process and self.process.returncode is not None:
                    raise MihomoError("Mihomo 进程提前退出")
                try:
                    response = await client.get(
                        f"{self.controller_url}/version", headers=self.headers
                    )
                    if response.is_success:
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.2)
        raise MihomoError("等待 Mihomo 控制端口超时")

    async def select(self, node_name: str) -> str:
        endpoint = quote(self.group_name, safe="")
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            response = await client.put(
                f"{self.controller_url}/proxies/{endpoint}",
                headers=self.headers,
                json={"name": node_name},
            )
            if not response.is_success:
                raise MihomoError(f"切换节点失败：HTTP {response.status_code}")

            deadline = asyncio.get_running_loop().time() + 5
            while asyncio.get_running_loop().time() < deadline:
                selected = await client.get(
                    f"{self.controller_url}/proxies/{endpoint}", headers=self.headers
                )
                if selected.is_success:
                    try:
                        payload = selected.json()
                    except ValueError:
                        payload = {}
                    current = payload.get("now") or payload.get("name")
                    if current == node_name:
                        return str(current)
                await asyncio.sleep(0.1)
        raise MihomoError(f"切换节点后未确认 selector 身份：{node_name}")

    def log_offset(self) -> int:
        if self._log_handle:
            self._log_handle.flush()
        return self.log_path.stat().st_size if self.log_path.exists() else 0

    def read_log_since(self, offset: int) -> str:
        if self._log_handle:
            self._log_handle.flush()
        if not self.log_path.exists():
            return ""
        with self.log_path.open("rb") as log_file:
            log_file.seek(offset)
            lines = log_file.read().decode("utf-8", errors="replace").splitlines()
        return " | ".join(lines[-4:])[-1000:]

    async def stop(self) -> None:
        process = self.process
        if not process or process.returncode is not None:
            self.process = None
            if self._log_handle:
                self._log_handle.close()
                self._log_handle = None
            return

        cleanup_task = asyncio.create_task(self._stop_process(process))
        cancelled = False
        try:
            while True:
                try:
                    await asyncio.shield(cleanup_task)
                    break
                except asyncio.CancelledError:
                    if cleanup_task.cancelled():
                        raise MihomoStopError("Mihomo 清理任务被取消") from None
                    cancelled = True
        except MihomoStopError:
            raise
        except Exception as exc:
            raise MihomoStopError("Mihomo 进程停止失败") from exc
        else:
            self.process = None
            if self._log_handle:
                self._log_handle.close()
                self._log_handle = None
            if cancelled:
                raise asyncio.CancelledError

    @staticmethod
    async def _stop_process(process: asyncio.subprocess.Process) -> None:
        with suppress(ProcessLookupError):
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=8)
        except TimeoutError:
            if process.returncode is None:
                with suppress(ProcessLookupError):
                    process.kill()
            try:
                await asyncio.wait_for(process.wait(), timeout=8)
            except TimeoutError as exc:
                raise MihomoStopError("Mihomo 进程未能停止") from exc

    @staticmethod
    def _read_log_tail(path: Path) -> str:
        if not path.exists():
            return ""
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return " | ".join(lines[-4:])[-800:]
