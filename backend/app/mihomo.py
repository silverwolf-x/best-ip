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


class MihomoError(RuntimeError):
    pass


_DEFAULT_DNS_CONFIG = {
    "enable": True,
    "ipv6": True,
    "enhanced-mode": "redir-host",
    "default-nameserver": ["1.1.1.1", "8.8.8.8"],
    "nameserver": [
        "https://1.1.1.1/dns-query",
        "https://8.8.8.8/dns-query",
    ],
    "proxy-server-nameserver": [
        "https://1.1.1.1/dns-query",
        "https://8.8.8.8/dns-query",
    ],
}


def _dns_servers(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item.strip()]


def _build_dns_config(source: dict[str, Any] | None) -> dict[str, Any]:
    if not source:
        return copy.deepcopy(_DEFAULT_DNS_CONFIG)

    config = copy.deepcopy(source)
    nameservers = _dns_servers(config.get("nameserver"))
    if not nameservers:
        nameservers = list(_DEFAULT_DNS_CONFIG["nameserver"])
    proxy_nameservers = _dns_servers(config.get("proxy-server-nameserver"))
    if not proxy_nameservers:
        proxy_nameservers = list(nameservers)

    config.update(
        {
            "enable": True,
            "enhanced-mode": "redir-host",
            "default-nameserver": _dns_servers(config.get("default-nameserver"))
            or list(_DEFAULT_DNS_CONFIG["default-nameserver"]),
            "nameserver": nameservers,
            "proxy-server-nameserver": proxy_nameservers,
        }
    )
    config.pop("fake-ip-range", None)
    config.pop("fake-ip-filter", None)
    return config


class MihomoProcess:
    group_name = "BEST-IP"

    def __init__(
        self,
        core_path: Path,
        work_dir: Path,
        proxies: list[dict[str, Any]],
        *,
        dns_config: dict[str, Any] | None = None,
    ) -> None:
        self.core_path = core_path
        self.work_dir = work_dir
        self.proxies = proxies
        self.dns_config = _build_dns_config(dns_config)
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
            raise MihomoError(
                f"未找到 Mihomo 核心：{self.core_path}。请运行 uv run scripts/download_mihomo.py"
            )

        self.work_dir.mkdir(parents=True, exist_ok=False)
        config_path = self.work_dir / "config.yaml"
        config = {
            "mixed-port": self.mixed_port,
            "allow-lan": False,
            "bind-address": "127.0.0.1",
            "mode": "rule",
            "log-level": "warning",
            "ipv6": True,
            "external-controller": f"127.0.0.1:{self.controller_port}",
            "secret": self.secret,
            "profile": {"store-selected": False, "store-fake-ip": False},
            "dns": self.dns_config,
            "proxies": self.proxies,
            "proxy-groups": [
                {
                    "name": self.group_name,
                    "type": "select",
                    "proxies": [proxy["name"] for proxy in self.proxies],
                }
            ],
            "rules": [
                f"DOMAIN,{COFFEE_HOST},{self.group_name}",
                "MATCH,REJECT",
            ],
        }
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
        except Exception:
            await self.stop()
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
        try:
            if process and process.returncode is None:
                with suppress(ProcessLookupError):
                    process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=8)
                except TimeoutError:
                    if process.returncode is None:
                        with suppress(ProcessLookupError):
                            process.kill()
                    await process.wait()
        finally:
            self.process = None
            if self._log_handle:
                self._log_handle.close()
                self._log_handle = None

    @staticmethod
    def _read_log_tail(path: Path) -> str:
        if not path.exists():
            return ""
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return " | ".join(lines[-4:])[-800:]
