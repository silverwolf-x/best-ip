from __future__ import annotations

import asyncio
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
    stream_bounded_get,
)
from .ipure_config import load_ipure_headers
from .values import _clean_text, _numeric_score

# 场景 id 与 https://ipure.dev/docs/api 的 scenarios[].id 一一对应。
IPURE_SCENARIOS = {
    "ai": "AI 服务",
    "social": "社交平台注册",
    "streaming": "流媒体 / 短视频",
    "gaming": "游戏平台",
    "ecommerce": "跨境电商",
    "email": "邮件发送",
}

# 官网要求：这些档位下 score 不代表可用性，引用时不能当作结论。
IPURE_NON_JUDGABLE_LEVELS = frozenset({"restricted", "not_applicable", "unusable"})

IPURE_MAX_ATTEMPTS = 4

# 单次尝试的硬上限。未收录 IP 的实时多源查询很慢，若让一次尝试吃满整个时间预算，
# 卡住的连接会挤掉后面所有重试；限制单次时长才能让重试真正发生。
IPURE_MAX_ATTEMPT_SECONDS = 10.0

# 直连兜底的硬上限。本机直连 IPure 实测在 1 秒级返回，慢一点也无所谓。
IPURE_DIRECT_TIMEOUT_SECONDS = 20.0

# 未收录 IP 的实时多源查询会偶发被对端直接断开（RemoteProtocolError / IncompleteRead），
# 这类瞬时错误重试即可恢复，不应当成"拿不到分数"。
_IPURE_TRANSIENT_ERRORS = (
    httpx.ConnectError,
    httpx.ReadError,
    httpx.WriteError,
    httpx.RemoteProtocolError,
    httpx.TimeoutException,
    TimeoutError,
)


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
        response = await _get_with_retry(
            transport,
            client,
            url,
            timeout_seconds=timeout_seconds,
            started=started,
        )
        if 300 <= response.status_code < 400:
            return _ipure_request_result(
                transport.proxy_url,
                url,
                started,
                status_code=response.status_code,
                error="IPure 请求被重定向，已按策略拒绝跟随",
                error_type="RedirectRejected",
                location=response.headers.get("location"),
            )
        payload = _json_payload(response)
        if not response.is_success:
            message, error_type, skipped = _response_error(response, payload)
            return _ipure_request_result(
                transport.proxy_url,
                url,
                started,
                status_code=response.status_code,
                error=message,
                error_type=error_type,
                skipped=skipped,
                location=response.headers.get("location"),
                report_url=_report_url(payload),
                budget_remaining=_budget_remaining(response),
            )
        report = _parse_ipure_report(payload)
        if report is None:
            return _ipure_request_result(
                transport.proxy_url,
                url,
                started,
                status_code=response.status_code,
                error="IPure API 响应缺少纯净度总分",
                error_type="ResponseParseError",
                budget_remaining=_budget_remaining(response),
            )
        return _ipure_request_result(
            transport.proxy_url,
            url,
            started,
            status_code=response.status_code,
            data=report,
            budget_remaining=_budget_remaining(response),
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
    except _IPURE_TRANSIENT_ERRORS:
        fallback = await _direct_report(
            transport.proxy_url, url, timeout_seconds=timeout_seconds
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


async def _get_with_retry(
    transport: ProxyTransport,
    client: httpx.AsyncClient,
    url: str,
    *,
    timeout_seconds: float,
    started: float,
) -> httpx.Response:
    """Retry the documented 429 and transient transport resets, inside one time budget."""

    for attempt in range(IPURE_MAX_ATTEMPTS):
        remaining = timeout_seconds - (perf_counter() - started)
        if remaining <= 0:
            raise TimeoutError
        try:
            response = await transport.get(
                client,
                url,
                timeout=min(remaining, IPURE_MAX_ATTEMPT_SECONDS),
                max_bytes=IPURE_MAX_RESPONSE_BYTES,
            )
        except _IPURE_TRANSIENT_ERRORS:
            if attempt == IPURE_MAX_ATTEMPTS - 1:
                raise
            delay = _retry_delay(None, attempt)
            if delay >= timeout_seconds - (perf_counter() - started):
                raise
            await asyncio.sleep(delay)
            continue
        if response.status_code != 429 or attempt == IPURE_MAX_ATTEMPTS - 1:
            return response
        delay = _retry_delay(response, attempt)
        if delay >= timeout_seconds - (perf_counter() - started):
            return response
        await asyncio.sleep(delay)
    raise TimeoutError


async def _direct_report(
    proxy_url: str,
    url: str,
    *,
    timeout_seconds: float,
) -> dict[str, Any] | None:
    """Fetch the same report without the node egress when the node cannot reach IPure.

    IPure keys its report on the queried address, not on who asked, so this returns the
    same document the node would have received. It is evidence from a different vantage
    point and is recorded as such; nothing else in the scan ever leaves the proxy.
    """

    started = perf_counter()
    try:
        _validate_ipure_url(url)
        headers = dict(load_ipure_headers())
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(min(timeout_seconds, IPURE_DIRECT_TIMEOUT_SECONDS)),
            follow_redirects=False,
            trust_env=False,
            headers=headers,
        ) as client:
            response = await stream_bounded_get(
                client,
                url,
                timeout=httpx.Timeout(min(timeout_seconds, IPURE_DIRECT_TIMEOUT_SECONDS)),
                max_bytes=IPURE_MAX_RESPONSE_BYTES,
                headers=headers,
            )
        if not response.is_success:
            return None
        report = _parse_ipure_report(_json_payload(response))
        if report is None:
            return None
        return _ipure_request_result(
            proxy_url,
            url,
            started,
            status_code=response.status_code,
            data=report,
            direct_fallback=True,
            budget_remaining=_budget_remaining(response),
        )
    except (httpx.HTTPError, ValueError, TimeoutError):
        return None


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    delay = float(2**attempt)
    retry_after = response.headers.get("Retry-After", "") if response is not None else ""
    if retry_after.isdigit():
        delay = max(delay, float(retry_after))
    return delay


def _response_error(
    response: httpx.Response,
    payload: Any,
) -> tuple[str, str, bool]:
    code = payload.get("code") if isinstance(payload, dict) else None
    code_suffix = f"，{code}" if isinstance(code, str) and code else ""
    if response.status_code == 403:
        if code == "verification_required":
            message = "IPure 当日免验证额度已用完，请在浏览器打开报告地址完成一次检测"
        else:
            message = f"IPure 拒绝访问（HTTP 403{code_suffix}）"
        return message, "EnrichmentUnavailable", True
    if response.status_code == 429:
        return (
            f"IPure 查询频率受限（HTTP 429{code_suffix}）",
            "EnrichmentUnavailable",
            True,
        )
    return f"HTTP {response.status_code}", "HTTPStatusError", False


def _json_payload(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _report_url(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    return _clean_text(payload.get("reportUrl")) or None


def _budget_remaining(response: httpx.Response) -> int | None:
    value = response.headers.get("x-open-budget-remaining", "").strip()
    return int(value) if value.isdigit() else None


def _ipure_url(exit_ip: str) -> str:
    normalized = str(ipaddress.ip_address(exit_ip))
    return f"{IPURE_ORIGIN}/api/lookup?{urlencode({'ip': normalized})}"


def _parse_ipure_report(payload: Any) -> dict[str, Any] | None:
    """Normalize one /api/lookup report; the purity total is the only hard requirement."""

    if not isinstance(payload, dict):
        return None
    risk = payload.get("risk") if isinstance(payload.get("risk"), dict) else {}
    total = _numeric_score(risk.get("purity"))
    if total is None:
        return None

    scenarios = payload.get("scenarios") if isinstance(payload.get("scenarios"), list) else []
    by_id = {
        item.get("id"): item
        for item in scenarios
        if isinstance(item, dict) and item.get("id") in IPURE_SCENARIOS
    }
    parsed_scenarios: dict[str, dict[str, Any]] = {}
    for scenario_id in IPURE_SCENARIOS:
        item = by_id.get(scenario_id)
        if item is None:
            parsed_scenarios[scenario_id] = {"score": None, "level": None, "label": None}
            continue
        parsed_scenarios[scenario_id] = {
            "score": _numeric_score(item.get("score")),
            "level": _clean_text(item.get("level")) or None,
            "label": _clean_text(item.get("levelLabel")) or None,
        }

    scenario_applicable = payload.get("scenarioApplicable")
    stale = payload.get("stale")
    return {
        "total": total,
        "scenarios": parsed_scenarios,
        "level": _clean_text(risk.get("level")) or None,
        "label": _clean_text(risk.get("label")) or None,
        "verdict": _clean_text(risk.get("verdict")) or None,
        "confidence": _clean_text(risk.get("confidence")) or None,
        "source": _clean_text(payload.get("source")) or None,
        "stale": stale if isinstance(stale, bool) else None,
        "queried_at": _clean_text(payload.get("queriedAt")) or None,
        "scenario_applicable": (
            scenario_applicable if isinstance(scenario_applicable, bool) else None
        ),
        "scenario_note": _clean_text(payload.get("scenarioNote")) or None,
        "report_url": _clean_text(payload.get("reportUrl")) or None,
    }


def _ipure_scores(result: dict[str, Any]) -> dict[str, int | None]:
    """Flatten a report into the node record's score map; every key is always present."""

    data = result.get("data") if isinstance(result.get("data"), dict) else None
    scores: dict[str, int | None] = {
        key: None for key in ("total", *IPURE_SCENARIOS)
    }
    if data is None:
        return scores
    scores["total"] = _numeric_score(data.get("total"))
    scenarios = data.get("scenarios") if isinstance(data.get("scenarios"), dict) else {}
    for scenario_id in IPURE_SCENARIOS:
        item = scenarios.get(scenario_id)
        if isinstance(item, dict):
            scores[scenario_id] = _numeric_score(item.get("score"))
    return scores


def _ipure_scenario_levels(result: dict[str, Any]) -> dict[str, str | None]:
    data = result.get("data") if isinstance(result.get("data"), dict) else None
    nested = data.get("scenarios") if isinstance(data, dict) else None
    scenarios = nested if isinstance(nested, dict) else {}
    levels: dict[str, str | None] = {}
    for scenario_id in IPURE_SCENARIOS:
        item = scenarios.get(scenario_id)
        levels[scenario_id] = item.get("level") if isinstance(item, dict) else None
    return levels


def _ipure_field(result: dict[str, Any], key: str) -> Any:
    data = result.get("data") if isinstance(result.get("data"), dict) else None
    return data.get(key) if isinstance(data, dict) else None


def _ipure_request_result(
    proxy_url: str,
    url: str,
    started: float,
    *,
    status_code: int | None = None,
    data: dict[str, Any] | None = None,
    error: str | None = None,
    error_type: str | None = None,
    location: str | None = None,
    skipped: bool = False,
    report_url: str | None = None,
    budget_remaining: int | None = None,
    direct_fallback: bool = False,
) -> dict[str, Any]:
    return {
        "url": url,
        "attempted": True,
        "via_mihomo": not direct_fallback,
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
        "report_url": report_url or (data.get("report_url") if isinstance(data, dict) else None),
        "budget_remaining": budget_remaining,
        "direct_fallback": direct_fallback,
    }
