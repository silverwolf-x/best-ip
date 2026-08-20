from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
import yaml


class SubscriptionError(ValueError):
    pass


MIHOMO_FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")
PUBLIC_DOH_URL = "https://cloudflare-dns.com/dns-query"


async def validate_public_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SubscriptionError("订阅地址必须是有效的 HTTP 或 HTTPS URL")
    if parsed.username or parsed.password:
        raise SubscriptionError("订阅地址不支持 URL 用户名或密码")

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise SubscriptionError("订阅地址不能指向本机")

    hostname_is_ip = False
    try:
        addresses = [ipaddress.ip_address(hostname)]
        hostname_is_ip = True
    except ValueError:
        try:
            loop = asyncio.get_running_loop()
            infos = await loop.getaddrinfo(
                hostname,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
            addresses = list({ipaddress.ip_address(item[4][0]) for item in infos})
        except (OSError, ValueError) as exc:
            raise SubscriptionError("无法解析订阅地址的域名") from exc

    if not hostname_is_ip and any(address in MIHOMO_FAKE_IP_NETWORK for address in addresses):
        addresses = await _resolve_with_public_doh(hostname)
    if not addresses or any(not address.is_global for address in addresses):
        raise SubscriptionError("订阅地址不能指向内网、回环或保留地址")


async def _resolve_with_public_doh(
    hostname: str,
) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            responses = await asyncio.gather(
                client.get(
                    PUBLIC_DOH_URL,
                    params={"name": hostname, "type": "A"},
                    headers={"Accept": "application/dns-json"},
                ),
                client.get(
                    PUBLIC_DOH_URL,
                    params={"name": hostname, "type": "AAAA"},
                    headers={"Accept": "application/dns-json"},
                ),
            )
            addresses = []
            for response in responses:
                response.raise_for_status()
                for item in response.json().get("Answer", []):
                    if item.get("type") in {1, 28} and item.get("data"):
                        addresses.append(ipaddress.ip_address(item["data"]))
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
        raise SubscriptionError("无法通过公共 DNS 核验订阅地址") from exc

    if not addresses:
        raise SubscriptionError("订阅地址没有可用的公网 DNS 记录")
    return list(dict.fromkeys(addresses))


async def download_subscription(
    url: str,
    *,
    max_bytes: int,
    timeout_seconds: float,
) -> bytes:
    current_url = url.strip()
    timeout = httpx.Timeout(timeout_seconds)
    headers = {
        "User-Agent": "clash.meta",
        "Accept": "application/yaml,text/yaml,text/plain,*/*",
    }

    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        trust_env=False,
    ) as client:
        for _ in range(6):
            await validate_public_url(current_url)
            async with client.stream("GET", current_url, headers=headers) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise SubscriptionError("订阅地址返回了无目标的重定向")
                    current_url = urljoin(current_url, location)
                    continue
                if response.status_code >= 400:
                    raise SubscriptionError(f"下载订阅失败：HTTP {response.status_code}")

                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise SubscriptionError("订阅内容超过允许大小")
                    chunks.append(chunk)
                return b"".join(chunks)

    raise SubscriptionError("订阅地址重定向次数过多")


def parse_subscription(content: bytes, *, max_nodes: int) -> list[dict[str, Any]]:
    try:
        document = yaml.safe_load(content.decode("utf-8-sig"))
    except (UnicodeDecodeError, yaml.YAMLError) as exc:
        raise SubscriptionError("订阅不是有效的 UTF-8 Mihomo YAML") from exc

    if not isinstance(document, dict) or not isinstance(document.get("proxies"), list):
        raise SubscriptionError("订阅必须是顶部含 proxies 列表的 Mihomo YAML")

    proxies = document["proxies"]
    if not proxies:
        raise SubscriptionError("订阅中没有节点")
    if len(proxies) > max_nodes:
        raise SubscriptionError(f"订阅含 {len(proxies)} 个节点，超过上限 {max_nodes}")

    names: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, proxy in enumerate(proxies, start=1):
        if not isinstance(proxy, dict):
            raise SubscriptionError(f"第 {index} 个节点配置不是对象")
        name = proxy.get("name")
        proxy_type = proxy.get("type")
        if not isinstance(name, str) or not name.strip():
            raise SubscriptionError(f"第 {index} 个节点缺少有效名称")
        if not isinstance(proxy_type, str) or not proxy_type.strip():
            raise SubscriptionError(f"节点“{name}”缺少有效类型")
        if name in names:
            raise SubscriptionError(f"订阅含重名节点：“{name}”")
        names.add(name)
        normalized.append(dict(proxy))

    return normalized
