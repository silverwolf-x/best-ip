from __future__ import annotations

import asyncio
import ipaddress
import json
from time import perf_counter
from typing import Any
from urllib.parse import urlencode

import httpx

from .http import (
    IPURE_HOST,
    IPURE_MAX_RESPONSE_BYTES,
    IPURE_ORIGIN,
    ProxyTransport,
    ResponseTooLarge,
    _validate_ipure_url,
)
from .ipure_config import load_ipure_headers
from .values import _numeric_score

IPURE_SCORE_LABELS = {
    "ai": "AI 服务",
    "streaming": "流媒体 / 短视频",
    "ecommerce": "跨境电商",
    "email": "邮件发送",
}


async def request(
    transport: ProxyTransport,
    client: httpx.AsyncClient,
    url: str,
    *,
    timeout_seconds: float,
) -> dict[str, Any]:
    _validate_ipure_url(url)
    verification_cookie = ""
    started = perf_counter()
    try:
        verification_cookie = _verification_cookie()
        for attempt in range(3):
            remaining = timeout_seconds - (perf_counter() - started)
            if remaining <= 0:
                raise TimeoutError
            response = await transport.get(
                client, url, timeout=remaining, max_bytes=IPURE_MAX_RESPONSE_BYTES
            )
            if response.status_code != 429 or attempt == 2:
                break
            delay = float(2**attempt)
            retry_after = response.headers.get("Retry-After", "")
            if retry_after.isdigit():
                delay = max(delay, float(retry_after))
            if delay >= timeout_seconds - (perf_counter() - started):
                break
            await asyncio.sleep(delay)
        if 300 <= response.status_code < 400:
            return _ipure_request_result(
                transport.proxy_url,
                url,
                started,
                status_code=response.status_code,
                error="redirect_rejected",
                error_type="RedirectRejected",
                location=response.headers.get("location"),
            )
        try:
            payload = response.json()
        except ValueError:
            payload = None
        scores = _parse_ipure_scores(payload) if response.is_success else None
        error = None
        error_type = None
        if not response.is_success and verification_cookie and response.status_code == 403:
            fallback = await _direct_request(
                url,
                timeout_seconds=timeout_seconds,
                verification_cookie=verification_cookie,
            )
            if fallback is not None:
                return fallback
        if not response.is_success:
            if response.status_code == 403:
                error = "IPure 需要完成人机验证后才能查询"
                error_type = "EnrichmentUnavailable"
            elif response.status_code == 429:
                error = "IPure 查询频率受限"
                error_type = "EnrichmentUnavailable"
            else:
                error = f"HTTP {response.status_code}"
                error_type = "HTTPStatusError"
        elif scores is None:
            error = "IPure API 响应缺少完整评分"
            error_type = "ResponseParseError"
        return _ipure_request_result(
            transport.proxy_url,
            url,
            started,
            status_code=response.status_code,
            data=scores,
            error=error,
            error_type=error_type,
            location=response.headers.get("location"),
            skipped=error_type == "EnrichmentUnavailable",
        )
    except ResponseTooLarge as exc:
        return _ipure_request_result(
            transport.proxy_url,
            url,
            started,
            status_code=exc.status_code,
            error="IPure 响应超过大小限制",
            error_type="ResponseTooLarge",
        )
    except (httpx.ConnectError, httpx.TimeoutException, TimeoutError):
        if verification_cookie:
            fallback = await _direct_request(
                url,
                timeout_seconds=timeout_seconds,
                verification_cookie=verification_cookie,
            )
            if fallback is not None:
                return fallback
        return _ipure_request_result(
            transport.proxy_url,
            url,
            started,
            error="IPure 连接失败，请检查代理出口或稍后重试",
            error_type="EnrichmentUnavailable",
            skipped=True,
        )
    except Exception as exc:
        return _ipure_request_result(
            transport.proxy_url,
            url,
            started,
            error=exc.__class__.__name__,
            error_type=exc.__class__.__name__,
        )


async def _direct_request(
    url: str,
    *,
    timeout_seconds: float,
    verification_cookie: str,
) -> dict[str, Any] | None:
    started = perf_counter()
    try:
        _validate_ipure_url(url)
        headers = load_ipure_headers()
        if "cookie" not in headers:
            headers["Cookie"] = verification_cookie
        async with (
            httpx.AsyncClient(
                timeout=httpx.Timeout(timeout_seconds),
                follow_redirects=False,
                trust_env=False,
                headers=headers,
            ) as client,
            client.stream("GET", url) as response,
        ):
            body = bytearray()
            async for chunk in response.aiter_bytes():
                if len(body) + len(chunk) > IPURE_MAX_RESPONSE_BYTES:
                    return None
                body.extend(chunk)
            if not response.is_success:
                return None
            try:
                payload = json.loads(body)
            except ValueError:
                return None
        scores = _parse_ipure_scores(payload)
        if scores is None:
            return None
        return _ipure_request_result(
            None,
            url,
            started,
            status_code=response.status_code,
            data=scores,
            location=response.headers.get("location"),
            via_mihomo=False,
            direct_fallback=True,
            verification_session_used=True,
        )
    except (httpx.HTTPError, TimeoutError, ValueError):
        return None


def _verification_cookie() -> str:
    cookie = load_ipure_headers().get("cookie", "").strip()
    if not cookie or len(cookie) > 8192 or "\r" in cookie or "\n" in cookie:
        return ""
    return cookie


def _ipure_url(exit_ip: str) -> str:
    normalized = str(ipaddress.ip_address(exit_ip))
    return f"{IPURE_ORIGIN}/api/lookup?{urlencode({'ip': normalized})}"


def _parse_ipure_scores(payload: Any) -> dict[str, int] | None:
    if not isinstance(payload, dict):
        return None
    risk = payload.get("risk") if isinstance(payload.get("risk"), dict) else {}
    scenarios = payload.get("scenarios")
    if not isinstance(scenarios, list):
        return None

    scenario_scores = {
        item.get("id"): _numeric_score(item.get("score"))
        for item in scenarios
        if isinstance(item, dict) and item.get("id") in IPURE_SCORE_LABELS
    }
    scores: dict[str, int | None] = {"total": _numeric_score(risk.get("purity"))}
    for key in IPURE_SCORE_LABELS:
        scores[key] = scenario_scores.get(key)
    if any(value is None for value in scores.values()):
        return None
    return {key: int(value) for key, value in scores.items() if value is not None}


def _ipure_scores(result: dict[str, Any]) -> dict[str, int | None]:
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    return {key: _numeric_score(data.get(key)) for key in ("total", *IPURE_SCORE_LABELS)}


def _ipure_request_result(
    proxy_url: str,
    url: str,
    started: float,
    *,
    status_code: int | None = None,
    data: dict[str, int] | None = None,
    error: str | None = None,
    error_type: str | None = None,
    location: str | None = None,
    skipped: bool = False,
    via_mihomo: bool = True,
    direct_fallback: bool = False,
    verification_session_used: bool = False,
) -> dict[str, Any]:
    return {
        "url": url,
        "attempted": True,
        "via_mihomo": via_mihomo,
        "proxy_url": proxy_url,
        "target_host": IPURE_HOST,
        "ok": status_code is not None and 200 <= status_code < 300 and error is None,
        "status_code": status_code,
        "elapsed_ms": round((perf_counter() - started) * 1000),
        "data": data,
        "error": error,
        "error_type": error_type,
        "location": location,
        "skipped": skipped,
        "direct_fallback": direct_fallback,
        "verification_session_used": verification_session_used,
    }
