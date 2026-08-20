from __future__ import annotations

import asyncio
import os
import secrets
import socket
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import yaml


class MihomoError(RuntimeError):
    pass


class MihomoProcess:
    group_name = "BEST-IP"

    def __init__(self, core_path: Path, work_dir: Path, proxies: list[dict[str, Any]]) -> None:
        self.core_path = core_path
        self.work_dir = work_dir
        self.proxies = proxies
        self.mixed_port = self._free_port()
        self.controller_port = self._free_port()
        self.secret = secrets.token_urlsafe(24)
        self.process: asyncio.subprocess.Process | None = None
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
            "proxies": self.proxies,
            "proxy-groups": [
                {
                    "name": self.group_name,
                    "type": "select",
                    "proxies": [proxy["name"] for proxy in self.proxies],
                }
            ],
            "rules": [f"MATCH,{self.group_name}"],
        }
        config_path.write_text(
            yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8"
        )

        log_path = self.work_dir / "mihomo.log"
        self._log_handle = log_path.open("w", encoding="utf-8")
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
            detail = self._read_log_tail(log_path)
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

    async def select(self, node_name: str) -> None:
        endpoint = quote(self.group_name, safe="")
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            response = await client.put(
                f"{self.controller_url}/proxies/{endpoint}",
                headers=self.headers,
                json={"name": node_name},
            )
        if not response.is_success:
            raise MihomoError(f"切换节点失败：HTTP {response.status_code}")
        await asyncio.sleep(0.25)

    async def stop(self) -> None:
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=8)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
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
