from __future__ import annotations

import asyncio
from time import perf_counter
from typing import Any

import httpx

RESTRICTED_COUNTRIES = {"CN", "HK", "MO", "RU", "KP", "IR", "SY", "CU", "BY", "VE"}

SERVICE_SPECS = {
    "gpt": {
        "page_url": "https://ip.net.coffee/gpt/",
        "trace_url": "https://chatgpt.com/cdn-cgi/trace",
        "secondary_name": "api.openai.com",
        "secondary_url": "https://api.openai.com/",
        "status_url": "https://ip.net.coffee/gpt/status.json",
    },
    "claude": {
        "page_url": "https://ip.net.coffee/claude/",
        "trace_url": "https://claude.ai/cdn-cgi/trace",
        "secondary_name": "anthropic.com",
        "secondary_url": "https://www.anthropic.com/cdn-cgi/trace",
        "status_url": "https://ip.net.coffee/claude/status.json",
    },
}

GLOBAL_PING_TARGETS = [
    {"code": "hk", "name": "香港", "url": "https://hkg.speed.cloudflare.com/__down?bytes=0"},
    {"code": "jp", "name": "东京", "url": "https://nrt.speed.cloudflare.com/__down?bytes=0"},
    {"code": "sg", "name": "新加坡", "url": "https://sin.speed.cloudflare.com/__down?bytes=0"},
    {"code": "us", "name": "洛杉矶", "url": "https://lax.speed.cloudflare.com/__down?bytes=0"},
    {"code": "ca", "name": "温哥华", "url": "https://yvr.speed.cloudflare.com/__down?bytes=0"},
    {"code": "de", "name": "法兰克福", "url": "https://fra.speed.cloudflare.com/__down?bytes=0"},
    {"code": "fr", "name": "巴黎", "url": "https://cdg.speed.cloudflare.com/__down?bytes=0"},
    {"code": "cn", "name": "上海", "url": "https://sha.speed.cloudflare.com/__down?bytes=0"},
]


class HttpScanner:
    def __init__(self, proxy_url: str, *, timeout_ms: int) -> None:
        self.proxy_url = proxy_url
        self.timeout_seconds = timeout_ms / 1000

    async def scan_node(self, node_name: str, node_type: str) -> dict[str, Any]:
        started = perf_counter()
        timeout = httpx.Timeout(
            self.timeout_seconds,
            connect=min(self.timeout_seconds, 12),
        )
        async with httpx.AsyncClient(
            proxy=self.proxy_url,
            timeout=timeout,
            follow_redirects=True,
            trust_env=False,
            headers={"User-Agent": "Mozilla/5.0 best-ip/0.1 (Windows NT 10.0; Win64; x64)"},
        ) as client:
            # 1. 第一阶段：并发请求 3 大页面 + 3 大出口 trace
            (
                ip_page_request,
                gpt_page_request,
                claude_page_request,
                cf_trace,
                gpt_trace,
                claude_trace,
            ) = await asyncio.gather(
                self._request(client, "https://ip.net.coffee/ip/", payload="none"),
                self._request(client, SERVICE_SPECS["gpt"]["page_url"], payload="none"),
                self._request(client, SERVICE_SPECS["claude"]["page_url"], payload="none"),
                self._request(client, "https://ip.net.coffee/cdn-cgi/trace", payload="text"),
                self._request(client, SERVICE_SPECS["gpt"]["trace_url"], payload="text"),
                self._request(client, SERVICE_SPECS["claude"]["trace_url"], payload="text"),
            )

            cf_ip = _trace_value(cf_trace.get("data"), "ip")
            gpt_ip = _trace_value(gpt_trace.get("data"), "ip")
            claude_ip = _trace_value(claude_trace.get("data"), "ip")
            primary_exit_ip = gpt_ip or claude_ip or cf_ip or ""

            # 2. 第二阶段：并发请求 IP 全量 Lookup、GPT 风险、Claude 风险、全球 Ping、端口扫描
            ip_task = self._ip_result(
                client, cf_ip or primary_exit_ip, ip_page_request, cf_trace
            )
            gpt_task = self._service_result(
                client, "gpt", gpt_ip or primary_exit_ip, gpt_page_request, gpt_trace
            )
            claude_task = self._service_result(
                client, "claude", claude_ip or primary_exit_ip, claude_page_request, claude_trace
            )
            global_ping_task = self._measure_global_ping(client)
            portscan_task = self._portscan_result(client, primary_exit_ip)
            pingcheck_task = self._pingcheck_result(client, primary_exit_ip)

            (
                ip_page,
                gpt_page,
                claude_page,
                global_ping,
                port_scan,
                ping_check,
            ) = await asyncio.gather(
                ip_task,
                gpt_task,
                claude_task,
                global_ping_task,
                portscan_task,
                pingcheck_task,
            )

        pages = {"ip": ip_page, "gpt": gpt_page, "claude": claude_page}
        statuses = [page["status"] for page in pages.values()]
        if all(status == "success" for status in statuses):
            status = "success"
        elif any(status in {"success", "partial"} for status in statuses):
            status = "partial"
        else:
            status = "failed"

        gpt_geo = gpt_page.get("geo") or {}
        claude_geo = claude_page.get("geo") or {}
        ip_result = ip_page.get("result") or {}
        gpt_risk = gpt_page.get("risk") or {}
        claude_risk = claude_page.get("risk") or {}

        is_residential = (
            ip_result.get("isResidential")
            if ip_result.get("isResidential") is not None
            else gpt_risk.get("isResidential")
        )
        is_datacenter = (
            ip_result.get("is_datacenter")
            if ip_result.get("is_datacenter") is not None
            else gpt_risk.get("is_datacenter")
        )
        asn_num = ip_result.get("asn") or gpt_risk.get("asn") or claude_risk.get("asn")
        as_org = (
            ip_result.get("asOrganization")
            or gpt_risk.get("asOrganization")
            or claude_risk.get("asOrganization")
            or gpt_geo.get("isp")
            or claude_geo.get("isp")
            or ""
        )

        ip_score = _numeric_score(ip_result.get("trust_score"))
        score = next(
            (
                candidate
                for candidate in (ip_score, gpt_page.get("score"), claude_page.get("score"))
                if candidate is not None
            ),
            None,
        )

        # 提炼原生性、人机画像与运营商类型
        has_network_data = bool(ip_result or gpt_risk or claude_risk)
        is_native = (
            bool(not ip_result.get("is_bogon") and (is_residential or not is_datacenter))
            if has_network_data
            else None
        )
        traffic_profile = (
            "人机混合 / 爬虫偏多"
            if (ip_result.get("is_crawler") or ip_result.get("is_abuser"))
            else "人类访问偏多"
            if has_network_data
            else "未知"
        )
        company_type = (
            "ISP（家庭宽带）"
            if str(ip_result.get("company_type") or "").lower() == "isp" or is_residential
            else "Hosting（机房托管）"
            if is_datacenter
            else str(ip_result.get("company_type") or "未知")
        )

        # 提炼合并后的安全风险标记
        is_vpn = (
            bool(
                ip_result.get("is_vpn")
                or gpt_risk.get("is_vpn")
                or claude_risk.get("is_vpn")
            )
            if has_network_data
            else None
        )
        is_proxy = (
            bool(
                ip_result.get("is_proxy")
                or gpt_risk.get("is_proxy")
                or claude_risk.get("is_proxy")
            )
            if has_network_data
            else None
        )
        is_tor = (
            bool(
                ip_result.get("is_tor")
                or gpt_risk.get("is_tor")
                or claude_risk.get("is_tor")
            )
            if has_network_data
            else None
        )
        is_crawler = (
            bool(
                ip_result.get("is_crawler")
                or gpt_risk.get("is_crawler")
                or claude_risk.get("is_crawler")
            )
            if has_network_data
            else None
        )
        is_abuser = (
            bool(
                ip_result.get("is_abuser")
                or gpt_risk.get("is_abuser")
                or claude_risk.get("is_abuser")
            )
            if has_network_data
            else None
        )

        risk_flags = []
        if is_vpn:
            risk_flags.append("VPN")
        if is_proxy:
            risk_flags.append("代理")
        if is_tor:
            risk_flags.append("Tor")
        if is_crawler:
            risk_flags.append("爬虫")
        if is_abuser:
            risk_flags.append("滥用记录")

        if not has_network_data:
            security_status = "检测数据不足"
        elif risk_flags:
            security_status = "⚠️ " + " · ".join(risk_flags)
        else:
            security_status = "🛡️ 极度纯净 (无风险标记)"

        return {
            "node": node_name,
            "type": node_type,
            "status": status,
            "exit_ip": primary_exit_ip,
            "cidr": ip_result.get("cidr") or gpt_risk.get("cidr") or claude_risk.get("cidr") or "",
            "rdns": ip_result.get("rdns") or "",
            "ai_verdict": (ip_result.get("ai_verdict") or {}).get("label") or "",
            "egress_ips": {
                "cf": cf_ip,
                "gpt": gpt_ip,
                "claude": claude_ip,
            },
            "location": _location(gpt_geo or claude_geo or ip_result),
            "score": score,
            "gpt_access": gpt_page.get("access", ""),
            "claude_access": claude_page.get("access", ""),
            "is_residential": is_residential,
            "is_datacenter": is_datacenter,
            "is_native": is_native,
            "traffic_profile": traffic_profile,
            "company_type": company_type,
            "is_vpn": is_vpn,
            "is_proxy": is_proxy,
            "is_tor": is_tor,
            "is_crawler": is_crawler,
            "is_abuser": is_abuser,
            "security_status": security_status,
            "asn": asn_num,
            "as_org": as_org,
            "global_ping": global_ping,
            "port_scan": port_scan,
            "ping_check": ping_check,
            "elapsed_ms": round((perf_counter() - started) * 1000),
            "pages": pages,
        }

    async def _ip_result(
        self,
        client: httpx.AsyncClient,
        exit_ip: str,
        page_request: dict[str, Any],
        trace: dict[str, Any],
    ) -> dict[str, Any]:
        lookup = (
            await self._request(
                client,
                f"https://ip.net.coffee/api/ip/lookup/{exit_ip}",
                payload="json",
            )
            if exit_ip
            else _missing_result("未取得 ip.net.coffee 出口 IP")
        )
        status = _page_status(page_request, lookup)
        return {
            "name": "ip",
            "url": "https://ip.net.coffee/ip/",
            "status": status,
            "exit_ip": exit_ip,
            "score": _numeric_score((lookup.get("data") or {}).get("trust_score")),
            "page_request": page_request,
            "trace": trace,
            "lookup_request": _without_data(lookup),
            "result": lookup.get("data") if isinstance(lookup.get("data"), dict) else None,
            "error": _combined_error(page_request, trace, lookup),
        }

    async def _service_result(
        self,
        client: httpx.AsyncClient,
        name: str,
        exit_ip: str,
        page_request: dict[str, Any],
        trace: dict[str, Any],
    ) -> dict[str, Any]:
        spec = SERVICE_SPECS[name]
        if exit_ip:
            risk_task = self._request(
                client, f"https://ip.net.coffee/api/iprisk/{exit_ip}", payload="json"
            )
            geo_task = self._request(
                client, f"https://ip.net.coffee/api/geoip/{exit_ip}", payload="json"
            )
        else:
            risk_task = asyncio.sleep(0, result=_missing_result("未取得服务出口 IP"))
            geo_task = asyncio.sleep(0, result=_missing_result("未取得服务出口 IP"))

        risk_request, geo_request, secondary, service_status = await asyncio.gather(
            risk_task,
            geo_task,
            self._request(client, spec["secondary_url"], payload="none", any_response=True),
            self._request(client, spec["status_url"], payload="json"),
        )
        risk = risk_request.get("data") if isinstance(risk_request.get("data"), dict) else None
        geo = geo_request.get("data") if isinstance(geo_request.get("data"), dict) else None
        country_code = str((risk or {}).get("countryCode", "")).upper()
        restricted = country_code in RESTRICTED_COUNTRIES
        score = 0 if restricted else _numeric_score((risk or {}).get("trust_score"))
        connectivity = [
            {
                "name": "chatgpt.com" if name == "gpt" else "claude.ai",
                "url": spec["trace_url"],
                "ok": trace.get("ok", False),
                "status_code": trace.get("status_code"),
                "elapsed_ms": trace.get("elapsed_ms"),
                "error": trace.get("error"),
            },
            {
                "name": spec["secondary_name"],
                "url": spec["secondary_url"],
                "ok": secondary.get("ok", False),
                "status_code": secondary.get("status_code"),
                "elapsed_ms": secondary.get("elapsed_ms"),
                "error": secondary.get("error"),
            },
        ]
        access = _access_summary(connectivity, restricted)
        status = _page_status(page_request, risk_request)

        return {
            "name": name,
            "url": spec["page_url"],
            "status": status,
            "exit_ip": exit_ip,
            "score": score,
            "restricted": restricted,
            "access": access,
            "location": _location(geo or {}),
            "page_request": page_request,
            "trace": trace,
            "risk_request": _without_data(risk_request),
            "geo_request": _without_data(geo_request),
            "risk": risk,
            "geo": geo,
            "connectivity": connectivity,
            "service_status": service_status.get("data"),
            "service_status_request": _without_data(service_status),
            "error": _combined_error(page_request, trace, risk_request, geo_request),
        }

    async def _measure_global_ping(self, client: httpx.AsyncClient) -> list[dict[str, Any]]:
        async def ping_target(target: dict[str, str]) -> dict[str, Any]:
            started = perf_counter()
            try:
                # 使用短超时 3.5s 进行全球延迟采样
                res = await client.head(target["url"], timeout=3.5)
                ms = round((perf_counter() - started) * 1000)
                return {
                    "code": target["code"],
                    "name": target["name"],
                    "ok": res.is_success,
                    "elapsed_ms": ms,
                    "status": f"{ms} ms" if res.is_success else "不可达",
                }
            except Exception:
                return {
                    "code": target["code"],
                    "name": target["name"],
                    "ok": False,
                    "elapsed_ms": None,
                    "status": "超时",
                }

        results = await asyncio.gather(*(ping_target(t) for t in GLOBAL_PING_TARGETS))
        return list(results)

    async def _portscan_result(
        self, client: httpx.AsyncClient, exit_ip: str
    ) -> dict[str, Any] | None:
        if not exit_ip:
            return None
        res = await self._request(
            client, f"https://ip.net.coffee/api/ip/portscan/{exit_ip}", payload="json"
        )
        if res.get("ok") and isinstance(res.get("data"), dict):
            return res["data"].get("ports")
        return None

    async def _pingcheck_result(
        self, client: httpx.AsyncClient, exit_ip: str
    ) -> dict[str, Any] | None:
        if not exit_ip:
            return None
        res = await self._request(
            client, f"https://ip.net.coffee/api/ip/pingcheck/{exit_ip}", payload="json"
        )
        if res.get("ok") and isinstance(res.get("data"), dict):
            data = res["data"]
            return {
                "verdict": data.get("verdict", "unknown"),
                "reachable": data.get("reachable", False),
                "ok_nodes": data.get("ok_nodes", 0),
                "total_nodes": data.get("total_nodes", 0),
                "ok_ratio": data.get("ok_ratio", 0.0),
            }
        return None

    @staticmethod
    async def _request(
        client: httpx.AsyncClient,
        url: str,
        *,
        payload: str,
        any_response: bool = False,
    ) -> dict[str, Any]:
        started = perf_counter()
        try:
            response = await client.get(url)
            ok = True if any_response else response.is_success
            data: Any = None
            if payload == "json" and response.is_success:
                data = response.json()
            elif payload == "text" and response.is_success:
                data = response.text[:20000]
            return {
                "url": url,
                "ok": ok,
                "status_code": response.status_code,
                "elapsed_ms": round((perf_counter() - started) * 1000),
                "data": data,
                "error": None if ok else f"HTTP {response.status_code}",
            }
        except Exception as exc:
            return {
                "url": url,
                "ok": False,
                "status_code": None,
                "elapsed_ms": round((perf_counter() - started) * 1000),
                "data": None,
                "error": " ".join(str(exc).split())[:500] or exc.__class__.__name__,
            }


def _trace_value(data: Any, key: str) -> str:
    if not isinstance(data, str):
        return ""
    prefix = f"{key}="
    for line in data.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    return ""


def _page_status(page_request: dict[str, Any], data_request: dict[str, Any]) -> str:
    if page_request.get("ok") and data_request.get("ok"):
        return "success"
    if page_request.get("ok") or data_request.get("ok"):
        return "partial"
    return "failed"


def _access_summary(connectivity: list[dict[str, Any]], restricted: bool) -> str:
    if restricted:
        return "不可访问 · 地区受限"
    parts = []
    for item in connectivity:
        if item["ok"]:
            parts.append(f"{item['name']} 可达 {item['elapsed_ms']}ms")
        else:
            parts.append(f"{item['name']} 不可达")
    return " · ".join(parts)


def _location(geo: dict[str, Any]) -> str:
    return " ".join(
        str(geo.get(key, "")).strip() for key in ("country", "region", "city", "isp")
        if str(geo.get(key, "")).strip()
    )


def _numeric_score(value: Any) -> int | None:
    if isinstance(value, int | float):
        return round(value)
    return None


def _without_data(result: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in result.items() if key != "data"}


def _missing_result(message: str) -> dict[str, Any]:
    return {
        "url": "",
        "ok": False,
        "status_code": None,
        "elapsed_ms": 0,
        "data": None,
        "error": message,
    }


def _combined_error(*results: dict[str, Any]) -> str | None:
    errors = [result.get("error") for result in results if result.get("error")]
    return "；".join(dict.fromkeys(errors)) or None
