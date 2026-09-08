from __future__ import annotations

import ipaddress
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
    started = perf_counter()
    try:
        response = await transport.get(
            client, url, timeout=timeout_seconds, max_bytes=IPURE_MAX_RESPONSE_BYTES
        )
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
    except Exception as exc:
        return _ipure_request_result(
            transport.proxy_url,
            url,
            started,
            error=exc.__class__.__name__,
            error_type=exc.__class__.__name__,
        )


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
) -> dict[str, Any]:
    return {
        "url": url,
        "attempted": True,
        "via_mihomo": True,
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
    }
