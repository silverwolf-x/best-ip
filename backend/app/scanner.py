from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import re
from datetime import UTC, datetime
from math import isfinite
from time import perf_counter
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit

import httpx

COFFEE_HOST = "ip.net.coffee"
COFFEE_ORIGIN = f"https://{COFFEE_HOST}"
COFFEE_PAGE_URL = f"{COFFEE_ORIGIN}/ip/"
COFFEE_TRACE_URL = f"{COFFEE_ORIGIN}/cdn-cgi/trace"

GLOBAL_PING_NODES = [
    {"code": "cn", "name": "上海", "node": "n01"},
    {"code": "hk", "name": "香港", "node": "n02"},
    {"code": "jp", "name": "东京", "node": "n03"},
    {"code": "sg", "name": "新加坡", "node": "n04"},
    {"code": "us", "name": "洛杉矶", "node": "n09"},
    {"code": "ca", "name": "温哥华", "node": "n11"},
    {"code": "de", "name": "法兰克福", "node": "n13"},
    {"code": "fr", "name": "巴黎", "node": "n15"},
]


class CoffeeCollector:
    """Collect the Coffee IP page through one workspace Mihomo mixed-port."""

    def __init__(self, proxy_url: str, *, timeout_ms: int) -> None:
        proxy = httpx.URL(proxy_url)
        if (
            proxy.scheme != "http"
            or proxy.host != "127.0.0.1"
            or proxy.port is None
            or proxy.path not in {"", "/"}
        ):
            raise ValueError("Coffee 采集器只接受工作区 Mihomo 的 127.0.0.1 mixed-port")
        self.proxy_url = str(proxy.copy_with(path=""))
        self.timeout_seconds = timeout_ms / 1000

    def _deadline(self, cap_seconds: float) -> float:
        return min(self.timeout_seconds, cap_seconds)

    async def collect(
        self,
        *,
        job_id: str,
        node_index: int,
        node_name: str,
        node_type: str,
        selected_proxy: str,
        mihomo_instance: str,
    ) -> dict[str, Any]:
        started_at = _now()
        started = perf_counter()
        timeout = httpx.Timeout(
            self.timeout_seconds,
            connect=min(self.timeout_seconds, 12),
        )
        async with httpx.AsyncClient(
            proxy=self.proxy_url,
            timeout=timeout,
            follow_redirects=False,
            trust_env=False,
            headers={
                "User-Agent": "Mozilla/5.0 best-ip/0.2 (Coffee-only; workspace Mihomo)"
            },
        ) as client:
            page = await self._request(
                client,
                COFFEE_PAGE_URL,
                payload="html",
                timeout_seconds=self._deadline(12),
            )
            trace = await self._request(
                client,
                COFFEE_TRACE_URL,
                payload="text",
                timeout_seconds=self._deadline(8),
            )
            exit_ip = _trace_ip(trace.get("data"))

            lookup_url = (
                f"{COFFEE_ORIGIN}/api/ip/lookup/{quote(exit_ip, safe='')}" if exit_ip else ""
            )
            lookup = (
                await self._request(
                    client,
                    lookup_url,
                    payload="json",
                    timeout_seconds=self._deadline(45),
                )
                if exit_ip
                else _missing_result("", "Coffee trace 未返回合法出口 IP")
            )
            lookup_data = lookup.get("data") if isinstance(lookup.get("data"), dict) else {}
            if lookup.get("ok") and not _is_same_ip(lookup_data.get("ip"), exit_ip):
                lookup = {
                    **lookup,
                    "ok": False,
                    "error": "IP lookup 未返回与 Coffee trace 一致的 IP 数据",
                }
                lookup_data = {}

            if exit_ip:
                global_ping = await self._request(
                    client,
                    _global_ping_url(exit_ip),
                    payload="json",
                    timeout_seconds=self._deadline(8),
                )
                port_scan = await self._request(
                    client,
                    f"{COFFEE_ORIGIN}/api/ip/portscan/{exit_ip}?probe=0",
                    payload="json",
                    timeout_seconds=self._deadline(8),
                )
                ping_check = await self._request(
                    client,
                    f"{COFFEE_ORIGIN}/api/ip/pingcheck/{exit_ip}",
                    payload="json",
                    timeout_seconds=self._deadline(8),
                )
                related = await self._related_result(client, exit_ip, lookup_data)
            else:
                reason = "未取得 Coffee trace 出口 IP，未请求依赖出口 IP 的接口"
                global_ping = _missing_result("", reason)
                port_scan = _missing_result("", reason)
                ping_check = _missing_result("", reason)
                related = _missing_result("", reason)

        status = _node_status(
            page,
            trace,
            lookup,
            exit_ip,
            {
                "global_ping": global_ping,
                "port_scan": port_scan,
                "ping_check": ping_check,
                **(
                    {"related": related}
                    if lookup_data.get("related_pending")
                    or lookup_data.get("related_domains_pending")
                    else {}
                ),
            },
        )
        final_exit_ip = exit_ip if status != "failed" else None
        error = _combined_error(page, trace, lookup, global_ping, port_scan, ping_check, related)
        request_results = {
            "page": page,
            "trace": trace,
            "lookup": lookup,
            "global_ping": global_ping,
            "port_scan": port_scan,
            "ping_check": ping_check,
            "related": related,
        }
        completeness = _completeness(request_results, exit_ip, lookup_data)
        summary = _profile_summary(lookup_data)
        finished_at = _now()

        return {
            "schema_version": 1,
            "job_id": job_id,
            "node_index": node_index,
            "node": node_name,
            "type": node_type,
            "selected_proxy": selected_proxy,
            "coffee_page_url": COFFEE_PAGE_URL,
            "status": status,
            "error": error,
            "transport_error": None,
            "started_at": started_at,
            "finished_at": finished_at,
            "exit_ip": final_exit_ip,
            **summary,
            "global_ping": _global_ping_summary(global_ping),
            "port_scan": _port_scan_summary(port_scan),
            "ping_check": _ping_check_summary(ping_check),
            "related_domains": _related_domains(lookup_data, related),
            "elapsed_ms": round((perf_counter() - started) * 1000),
            "proxy_evidence": {
                "transport": "workspace_mihomo_mixed_port",
                "proxy_url": self.proxy_url,
                "mihomo_instance": mihomo_instance,
                "selector": "BEST-IP",
                "selected_proxy": selected_proxy,
                "selection_confirmed": selected_proxy == node_name,
                "target_origin": COFFEE_ORIGIN,
                "trust_env": False,
                "direct_fallback": False,
            },
            "completeness": completeness,
            "requests": request_results,
            "coffee": {
                "page": page.get("data"),
                "trace": trace.get("data"),
                "lookup": lookup.get("data"),
                "global_ping": global_ping.get("data"),
                "port_scan": port_scan.get("data"),
                "ping_check": ping_check.get("data"),
                "related": related.get("data"),
            },
            "pages": {
                "ip": {
                    "name": "ip",
                    "url": COFFEE_PAGE_URL,
                    "status": status,
                    "exit_ip": final_exit_ip,
                    "score": summary["score"],
                    "page_request": _without_data(page),
                    "trace": trace,
                    "lookup_request": _without_data(lookup),
                    "result": lookup_data or None,
                    "error": error,
                }
            },
        }

    async def _related_result(
        self,
        client: httpx.AsyncClient,
        exit_ip: str,
        lookup_data: dict[str, Any],
    ) -> dict[str, Any]:
        url = f"{COFFEE_ORIGIN}/api/ip/related/{exit_ip}"
        if not (
            lookup_data.get("related_pending") or lookup_data.get("related_domains_pending")
        ):
            return _missing_result(url, "lookup 已包含关联域名，无需轮询", skipped=True)

        attempts: list[dict[str, Any]] = []
        result: dict[str, Any] = _missing_result(url, "关联域名轮询未开始")
        for attempt in range(1, 11):
            if attempt > 1:
                await asyncio.sleep(1.5)
            result = await self._request(
                client,
                url,
                payload="json",
                timeout_seconds=self._deadline(8),
            )
            attempts.append(_without_data(result))
            data = result.get("data") if isinstance(result.get("data"), dict) else {}
            still_pending = data.get("pending") or data.get("related_domains_pending")
            if not result.get("ok") or not still_pending:
                break
        return {**result, "poll_attempts": attempts, "poll_count": len(attempts)}

    async def _request(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        payload: str,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        _validate_coffee_url(url)
        started = perf_counter()
        try:
            response = await client.get(url, timeout=timeout_seconds)
            if 300 <= response.status_code < 400:
                return {
                    "url": url,
                    "attempted": True,
                    "via_mihomo": True,
                    "proxy_url": self.proxy_url,
                    "target_host": COFFEE_HOST,
                    "ok": False,
                    "status_code": response.status_code,
                    "elapsed_ms": round((perf_counter() - started) * 1000),
                    "data": None,
                    "error": "redirect_rejected",
                    "error_type": "RedirectRejected",
                    "location": response.headers.get("location"),
                }
            data: Any = None
            parse_error: str | None = None
            if payload == "json":
                try:
                    data = response.json()
                except ValueError:
                    parse_error = "响应不是有效 JSON"
            elif payload == "text":
                data = response.text[:20000]
            elif payload == "html":
                body = response.content
                title_match = re.search(
                    rb"<title[^>]*>(.*?)</title>",
                    body,
                    flags=re.IGNORECASE | re.DOTALL,
                )
                title = (
                    re.sub(
                        r"\s+",
                        " ",
                        title_match.group(1).decode("utf-8", errors="replace"),
                    ).strip()
                    if title_match
                    else ""
                )
                data = {
                    "content_type": response.headers.get("content-type", ""),
                    "content_length": len(body),
                    "sha256": hashlib.sha256(body).hexdigest(),
                    "title": title,
                    "contains_ip_result": b'id="result"' in body or b"id='result'" in body,
                }
            else:
                raise ValueError(f"不支持的响应类型：{payload}")

            ok = response.is_success and parse_error is None
            if parse_error:
                error = parse_error
            elif not response.is_success:
                error = f"HTTP {response.status_code}"
            else:
                error = None
            return {
                "url": url,
                "attempted": True,
                "via_mihomo": True,
                "proxy_url": self.proxy_url,
                "target_host": COFFEE_HOST,
                "ok": ok,
                "status_code": response.status_code,
                "elapsed_ms": round((perf_counter() - started) * 1000),
                "data": data,
                "error": error,
                "error_type": "ResponseParseError" if parse_error else None,
                "location": response.headers.get("location"),
            }
        except Exception as exc:
            return {
                "url": url,
                "attempted": True,
                "via_mihomo": True,
                "proxy_url": self.proxy_url,
                "target_host": COFFEE_HOST,
                "ok": False,
                "status_code": None,
                "elapsed_ms": round((perf_counter() - started) * 1000),
                "data": None,
                "error": " ".join(str(exc).split())[:500] or exc.__class__.__name__,
                "error_type": exc.__class__.__name__,
                "location": None,
            }


def _validate_coffee_url(url: str) -> None:
    parsed = urlsplit(url)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f"Coffee 请求端口无效：{url}") from exc
    if parsed.scheme != "https" or parsed.hostname != COFFEE_HOST:
        raise ValueError(f"拒绝非 Coffee 同源请求：{url}")
    if parsed.username or parsed.password or port is not None or parsed.fragment:
        raise ValueError(f"拒绝带认证信息、自定义端口或 fragment 的 Coffee 请求：{url}")

    path = parsed.path or "/"
    query = parse_qs(parsed.query, keep_blank_values=True)
    if path in {"/ip/", "/cdn-cgi/trace"}:
        if query:
            raise ValueError(f"页面/trace 不允许 query：{url}")
        return
    if path.startswith("/api/ip/"):
        prefix = next(
            (
                item
                for item in (
                    "/api/ip/lookup/",
                    "/api/ip/related/",
                    "/api/ip/portscan/",
                    "/api/ip/pingcheck/",
                )
                if path.startswith(item)
            ),
            None,
        )
        if prefix is None:
            raise ValueError(f"拒绝未允许的 Coffee API path：{url}")
        value = unquote(path.removeprefix(prefix))
        try:
            ipaddress.ip_address(value)
        except ValueError as exc:
            raise ValueError(f"Coffee API IP 参数无效：{url}") from exc
        if prefix == "/api/ip/portscan/":
            if query != {"probe": ["0"]}:
                raise ValueError("portscan 只允许 probe=0 被动查询")
        elif query:
            raise ValueError(f"Coffee API 不允许额外 query：{url}")
        return
    if path == "/api/ping/global":
        hosts = query.get("host", [])
        nodes = query.get("node", [])
        if set(query) != {"host", "node"} or len(hosts) != 1:
            raise ValueError("global ping 必须只有一个 host")
        try:
            ipaddress.ip_address(unquote(hosts[0]))
        except ValueError as exc:
            raise ValueError("global ping host 无效") from exc
        allowed_nodes = {item["node"] for item in GLOBAL_PING_NODES}
        if len(nodes) != len(allowed_nodes) or set(nodes) != allowed_nodes:
            raise ValueError("global ping 必须使用固定八个 Coffee 节点")
        return
    raise ValueError(f"拒绝未允许的 Coffee path：{url}")


def _global_ping_url(exit_ip: str) -> str:
    params = [("host", exit_ip), *(('node', item["node"]) for item in GLOBAL_PING_NODES)]
    return f"{COFFEE_ORIGIN}/api/ping/global?{urlencode(params)}"


def _is_same_ip(value: Any, expected: str) -> bool:
    try:
        return ipaddress.ip_address(value) == ipaddress.ip_address(expected)
    except (TypeError, ValueError):
        return False


def _trace_ip(data: Any) -> str:
    value = _trace_value(data, "ip")
    try:
        return str(ipaddress.ip_address(value))
    except (TypeError, ValueError):
        return ""


def _trace_value(data: Any, key: str) -> str:
    if not isinstance(data, str):
        return ""
    prefix = f"{key}="
    for line in data.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    return ""


def _node_status(
    page: dict[str, Any],
    trace: dict[str, Any],
    lookup: dict[str, Any],
    exit_ip: str,
    optional: dict[str, dict[str, Any]] | None = None,
) -> str:
    required_ok = bool(page.get("ok") and trace.get("ok") and lookup.get("ok") and exit_ip)
    if not required_ok:
        return "failed"
    if optional and any(not _request_recorded(item) for item in optional.values()):
        return "partial"
    return "success"


def _profile_summary(ip_result: dict[str, Any]) -> dict[str, Any]:
    residential_value = ip_result.get("isResidential")
    datacenter_value = ip_result.get("is_datacenter")
    is_residential = residential_value if isinstance(residential_value, bool) else None
    is_datacenter = datacenter_value if isinstance(datacenter_value, bool) else None

    native_value = ip_result.get("is_native")
    is_native = native_value if isinstance(native_value, bool) else None
    crawler_value = ip_result.get("is_crawler")
    abuser_value = ip_result.get("is_abuser")
    crawler_signal = crawler_value if isinstance(crawler_value, bool) else None
    abuser_signal = abuser_value if isinstance(abuser_value, bool) else None
    if crawler_signal or abuser_signal:
        traffic_profile = "人机混合 / 爬虫偏多"
    elif crawler_signal is False and abuser_signal is False:
        traffic_profile = "人类访问偏多"
    else:
        traffic_profile = "未知"

    company_type_value = str(ip_result.get("company_type") or "").strip()
    if company_type_value.lower() == "isp" or is_residential:
        company_type = "ISP（家庭宽带）"
    elif is_datacenter:
        company_type = "Hosting（机房托管）"
    else:
        company_type = company_type_value or "未知"

    risk_keys = ("is_vpn", "is_proxy", "is_tor", "is_crawler", "is_abuser")
    risk_values = {
        key: ip_result.get(key) if isinstance(ip_result.get(key), bool) else None
        for key in risk_keys
    }
    risk_labels = {
        "is_vpn": "VPN",
        "is_proxy": "代理",
        "is_tor": "Tor",
        "is_crawler": "爬虫",
        "is_abuser": "滥用记录",
    }
    risk_flags = [risk_labels[key] for key, value in risk_values.items() if value]
    if risk_flags:
        security_status = "⚠️ " + " · ".join(risk_flags)
    elif all(value is not None for value in risk_values.values()):
        security_status = "🛡️ 极度纯净 (无风险标记)"
    elif ip_result:
        security_status = "检测数据不足"
    else:
        security_status = "检测失败"

    ai_verdict = (
        ip_result.get("ai_verdict") if isinstance(ip_result.get("ai_verdict"), dict) else {}
    )
    return {
        "cidr": ip_result.get("cidr") or "",
        "rdns": ip_result.get("rdns") or "",
        "ai_verdict": ai_verdict.get("label") or "",
        "location": _location(ip_result),
        "score": _numeric_score(ip_result.get("trust_score")),
        "is_residential": is_residential,
        "is_datacenter": is_datacenter,
        "is_native": is_native,
        "traffic_profile": traffic_profile,
        "company_type": company_type,
        **risk_values,
        "security_status": security_status,
        "asn": ip_result.get("asn"),
        "as_org": ip_result.get("asOrganization") or ip_result.get("isp") or "",
    }


def _global_ping_summary(response: dict[str, Any]) -> list[dict[str, Any]]:
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    latencies = data.get("results") if isinstance(data.get("results"), dict) else {}
    timeout_values = data.get("timeouts")
    pending_values = data.get("pending")
    timeouts = (
        {item for item in timeout_values if isinstance(item, str)}
        if isinstance(timeout_values, list)
        else set()
    )
    pending = (
        {item for item in pending_values if isinstance(item, str)}
        if isinstance(pending_values, list)
        else set()
    )
    request_error = data.get("error") or response.get("error")

    results = []
    for target in GLOBAL_PING_NODES:
        latency = latencies.get(target["node"])
        ok = _is_finite_number(latency) and latency >= 0
        elapsed_ms = round(latency) if ok else None
        if ok:
            status = f"{elapsed_ms} ms"
        elif target["node"] in timeouts:
            status = "超时"
        elif target["node"] in pending:
            status = "等待结果"
        elif response.get("attempted"):
            status = "未返回"
        else:
            status = "未检测"
        results.append(
            {
                "code": target["code"],
                "name": target["name"],
                "node": target["node"],
                "ok": ok,
                "elapsed_ms": elapsed_ms,
                "status": status,
                "error": str(request_error) if request_error else None,
            }
        )
    return results


def _port_scan_summary(response: dict[str, Any]) -> Any:
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    return data.get("ports")


def _ping_check_summary(response: dict[str, Any]) -> dict[str, Any] | None:
    data = response.get("data") if isinstance(response.get("data"), dict) else {}
    if not data:
        return None
    ok_nodes = data.get("ok_nodes", 0)
    total_nodes = data.get("total_nodes", 0)
    ok_ratio = (
        ok_nodes / total_nodes
        if _is_finite_number(ok_nodes)
        and _is_finite_number(total_nodes)
        and total_nodes > 0
        else 0.0
    )
    return {
        "verdict": data.get("verdict", "unknown"),
        "reachable": data.get("reachable", False),
        "ok_nodes": ok_nodes,
        "total_nodes": total_nodes,
        "ok_ratio": ok_ratio,
    }


def _related_domains(
    lookup_data: dict[str, Any], related_response: dict[str, Any]
) -> list[Any]:
    related_data = (
        related_response.get("data")
        if isinstance(related_response.get("data"), dict)
        else {}
    )
    values = related_data.get("related_domains")
    if not isinstance(values, list):
        values = lookup_data.get("related_domains")
    return values if isinstance(values, list) else []


def _completeness(
    requests: dict[str, dict[str, Any]],
    exit_ip: str,
    lookup_data: dict[str, Any],
) -> dict[str, Any]:
    checks = {
        "page_received": bool(requests["page"].get("ok")),
        "trace_received": bool(requests["trace"].get("ok")),
        "exit_ip_valid": bool(exit_ip),
        "lookup_received": bool(requests["lookup"].get("ok")),
        "lookup_matches_trace": bool(
            exit_ip and _is_same_ip(lookup_data.get("ip"), exit_ip)
        ),
        "global_ping_recorded": _request_recorded(requests["global_ping"]),
        "port_scan_recorded": _request_recorded(requests["port_scan"]),
        "ping_check_recorded": _request_recorded(requests["ping_check"]),
        "related_recorded": (
            _request_recorded(requests["related"])
            if lookup_data.get("related_pending") or lookup_data.get("related_domains_pending")
            else True
        ),
    }
    required = (
        "page_received",
        "trace_received",
        "exit_ip_valid",
        "lookup_received",
        "lookup_matches_trace",
    )
    missing = [name for name in required if not checks[name]]
    unrecorded = [
        name
        for name, value in checks.items()
        if name.endswith("_recorded") and not value
    ]
    return {
        "complete": not missing and not unrecorded,
        "checks": checks,
        "missing_required": missing,
        "unrecorded_requests": unrecorded,
    }


def _request_recorded(result: dict[str, Any]) -> bool:
    return bool(result.get("attempted") and result.get("status_code") is not None)


def _location(geo: dict[str, Any]) -> str:
    return " ".join(
        str(geo.get(key, "")).strip()
        for key in ("country", "region", "city", "isp")
        if str(geo.get(key, "")).strip()
    )


def _is_finite_number(value: Any) -> bool:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return False
    try:
        return isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _numeric_score(value: Any) -> int | None:
    if _is_finite_number(value) and 0 <= value <= 100:
        return round(value)
    return None


def _without_data(result: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in result.items() if key != "data"}


def _missing_result(url: str, message: str, *, skipped: bool = False) -> dict[str, Any]:
    return {
        "url": url,
        "attempted": False,
        "via_mihomo": False,
        "proxy_url": None,
        "target_host": COFFEE_HOST if url else None,
        "ok": False,
        "status_code": None,
        "elapsed_ms": 0,
        "data": None,
        "error": message,
        "error_type": None,
        "location": None,
        "skipped": skipped,
    }


def _combined_error(*results: dict[str, Any]) -> str | None:
    errors = [result.get("error") for result in results if result.get("error")]
    return "；".join(dict.fromkeys(errors)) or None


def _now() -> str:
    return datetime.now(UTC).isoformat()


# Backward-compatible import name for callers migrating to the Coffee-only collector.
HttpScanner = CoffeeCollector
