from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
import yaml


class SubscriptionError(ValueError):
    """订阅错误。reason 是固定安全原因码，可进日志而不泄露订阅地址。"""

    def __init__(self, message: str, *, reason: str = "unknown") -> None:
        self.reason = reason
        super().__init__(message)


def subscription_failure_reason(exc: BaseException) -> str:
    """把订阅异常收敛成固定安全原因码，未知情况统一为 unknown。"""

    reason = getattr(exc, "reason", None)
    if isinstance(reason, str) and re.fullmatch(r"[a-z0-9_]{1,48}", reason):
        return reason
    return "unknown"


MIHOMO_FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")
PUBLIC_DOH_URL = "https://1.1.1.1/dns-query"
SUBSCRIPTION_METADATA_PATTERNS = (
    re.compile(r"^(?:剩余流量|流量剩余)[：:]\s*\d+(?:\.\d+)?\s*[KMGTPE]?B\b", re.I),
    re.compile(r"^(?:距离下次重置(?:剩余)?|下次重置)[：:]\s*\d+\s*天"),
    re.compile(r"^(?:套餐到期|到期时间)[：:]\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}"),
    re.compile(r"^官网[：:]\s*(?:https?://)?(?:[\w-]+\.)+[\w-]+", re.I),
    re.compile(r"^群组[：:]\s*(?:https?://)?(?:t\.me/|(?:[\w-]+\.)+[\w-]+)", re.I),
)


def is_subscription_metadata(proxy: dict[str, Any]) -> bool:
    name = str(proxy.get("name") or "").strip()
    return any(pattern.match(name) for pattern in SUBSCRIPTION_METADATA_PATTERNS)


async def validate_public_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SubscriptionError("订阅地址必须是有效的 HTTP 或 HTTPS URL", reason="non_http_scheme")
    if parsed.username or parsed.password:
        raise SubscriptionError("订阅地址不支持 URL 用户名或密码", reason="url_credentials")

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise SubscriptionError("订阅地址不能指向本机", reason="localhost_target")

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
            raise SubscriptionError("无法解析订阅地址的域名", reason="dns_unresolved") from exc

    if not hostname_is_ip and any(address in MIHOMO_FAKE_IP_NETWORK for address in addresses):
        addresses = await _resolve_with_public_doh(hostname)
    if not addresses or any(not address.is_global for address in addresses):
        raise SubscriptionError("订阅地址不能指向内网、回环或保留地址", reason="dns_not_global")


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
                return_exceptions=True,
            )
            addresses = []
            for response in responses:
                if isinstance(response, Exception) or response.status_code >= 400:
                    continue
                try:
                    answers = response.json().get("Answer", [])
                except (ValueError, TypeError):
                    continue
                for item in answers:
                    if not isinstance(item, dict) or item.get("type") not in {1, 28}:
                        continue
                    try:
                        addresses.append(ipaddress.ip_address(item["data"]))
                    except (KeyError, ValueError, TypeError):
                        continue
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
        raise SubscriptionError("无法通过公共 DNS 核验订阅地址", reason="doh_unavailable") from exc

    if not addresses:
        raise SubscriptionError("订阅地址没有可用的公网 DNS 记录", reason="dns_no_public_records")
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
                        raise SubscriptionError(
                            "订阅地址返回了无目标的重定向", reason="redirect_without_location"
                        )
                    current_url = urljoin(current_url, location)
                    continue
                if response.status_code >= 400:
                    raise SubscriptionError(
                        f"下载订阅失败：HTTP {response.status_code}",
                        reason=f"http_status_{response.status_code}",
                    )

                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise SubscriptionError("订阅内容超过允许大小", reason="response_too_large")
                    chunks.append(chunk)
                return b"".join(chunks)

    raise SubscriptionError("订阅地址重定向次数过多", reason="redirect_limit")


def parse_subscription(content: bytes, *, max_nodes: int) -> list[dict[str, Any]]:
    try:
        document = yaml.safe_load(content.decode("utf-8-sig"))
    except (UnicodeDecodeError, yaml.YAMLError) as exc:
        raise SubscriptionError(
            "订阅不是有效的 UTF-8 Mihomo YAML", reason="body_not_utf8_yaml"
        ) from exc

    if not isinstance(document, dict) or not isinstance(document.get("proxies"), list):
        raise SubscriptionError(
            "订阅必须是顶部含 proxies 列表的 Mihomo YAML", reason="body_not_mihomo_yaml"
        )

    proxies = document["proxies"]
    if not proxies:
        raise SubscriptionError("订阅中没有节点", reason="body_no_proxies")
    detectable_count = sum(
        1
        for proxy in proxies
        if not isinstance(proxy, dict) or not is_subscription_metadata(proxy)
    )
    if detectable_count > max_nodes:
        raise SubscriptionError(
            f"订阅含 {detectable_count} 个节点，超过上限 {max_nodes}", reason="body_too_many_nodes"
        )

    names: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, proxy in enumerate(proxies, start=1):
        if not isinstance(proxy, dict):
            raise SubscriptionError(f"第 {index} 个节点配置不是对象", reason="node_not_object")
        if is_subscription_metadata(proxy):
            normalized.append(dict(proxy))
            continue
        name = proxy.get("name")
        proxy_type = proxy.get("type")
        if not isinstance(name, str) or not name.strip():
            raise SubscriptionError(f"第 {index} 个节点缺少有效名称", reason="node_name_missing")
        if not isinstance(proxy_type, str) or not proxy_type.strip():
            raise SubscriptionError(f"第 {index} 个节点缺少有效类型", reason="node_type_missing")
        if proxy_type.strip().lower() in {"direct", "reject"}:
            raise SubscriptionError(
                f"第 {index} 个节点使用了不允许的直连/拒绝类型", reason="node_type_forbidden"
            )
        if name in names:
            raise SubscriptionError(f"第 {index} 个节点名称重复", reason="node_name_duplicate")
        names.add(name)
        normalized.append(dict(proxy))

    return normalized
