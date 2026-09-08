from __future__ import annotations

import asyncio
from time import perf_counter
from typing import Any

import httpx

from .http import (
    GPT_PROBE_TARGETS,
    ProxyTransport,
    _validate_gpt_url,
)
from .values import _clean_text, _is_finite_number

GPT_RESTRICTED_COUNTRIES = {"CN", "HK", "MO", "RU", "IR", "KP", "CU", "SY"}
GPT_CHECK_TIMEOUT_SECONDS = 6.0

_GPT_ACCEPTED_STATUS_CODES = {200, 204}


async def requests(
    transport: ProxyTransport,
    client: httpx.AsyncClient,
) -> dict[str, dict[str, Any]]:
    responses = await asyncio.gather(
        *(probe_endpoint(transport, client, target) for target in GPT_PROBE_TARGETS)
    )
    return {
        target["name"]: response
        for target, response in zip(GPT_PROBE_TARGETS, responses, strict=True)
    }


async def probe_endpoint(
    transport: ProxyTransport,
    client: httpx.AsyncClient,
    target: dict[str, str],
) -> dict[str, Any]:
    """Probe one GPT endpoint through this node's Mihomo mixed port."""
    name = target["name"]
    url = target["url"]
    _validate_gpt_url(url, name)
    started = perf_counter()
    try:
        response = await transport.get(
            client,
            url,
            timeout=httpx.Timeout(
                GPT_CHECK_TIMEOUT_SECONDS,
                connect=min(GPT_CHECK_TIMEOUT_SECONDS, 5),
            ),
        )
        status_code = response.status_code
        accepted = _gpt_response_connected(name, status_code)
        redirected = 300 <= status_code < 400
        headers = getattr(response, "headers", {})
        return {
            "name": name,
            "url": url,
            "attempted": True,
            "via_mihomo": True,
            "proxy_url": transport.proxy_url,
            "target_host": name,
            "ok": accepted,
            "status_code": status_code,
            "elapsed_ms": round((perf_counter() - started) * 1000),
            "data": None,
            "error": (
                None if accepted else ("redirect_rejected" if redirected else f"HTTP {status_code}")
            ),
            "error_type": (
                None if accepted else ("RedirectRejected" if redirected else "HTTPStatusError")
            ),
            "location": headers.get("location"),
        }
    except Exception as exc:
        return {
            "name": name,
            "url": url,
            "attempted": True,
            "via_mihomo": True,
            "proxy_url": transport.proxy_url,
            "target_host": name,
            "ok": False,
            "status_code": None,
            "elapsed_ms": -1,
            "data": None,
            "error": exc.__class__.__name__,
            "error_type": exc.__class__.__name__,
            "location": None,
        }


def _gpt_response_connected(name: str, status_code: int) -> bool:
    if name == "api.openai.com":
        return status_code in {*_GPT_ACCEPTED_STATUS_CODES, 401}
    return status_code in _GPT_ACCEPTED_STATUS_CODES


def _gpt_check_summary(
    responses: list[dict[str, Any]] | tuple[dict[str, Any], ...] | dict[str, Any] | None,
    lookup_data: dict[str, Any] | str | None = None,
) -> list[dict[str, Any]]:
    """Convert GPT probe request records into the public availability summary."""
    if not responses:
        return []

    by_name: dict[str, dict[str, Any]] = {}
    if isinstance(responses, dict):
        for name, response in responses.items():
            if isinstance(response, dict):
                by_name[str(name)] = response
    else:
        for response in responses:
            if not isinstance(response, dict):
                continue
            name = response.get("name")
            if isinstance(name, str) and name:
                by_name[name] = response

    country_code = (
        _clean_text(lookup_data.get("countryCode") or lookup_data.get("country_code")).upper()
        if isinstance(lookup_data, dict)
        else str(lookup_data or "").strip().upper()
    )
    summaries: list[dict[str, Any]] = []
    for target in GPT_PROBE_TARGETS:
        response = by_name.get(target["name"], {})
        status_code = response.get("status_code")
        if not isinstance(status_code, int) or isinstance(status_code, bool):
            status_code = None
        elapsed = response.get("elapsed_ms")
        elapsed_ms = round(elapsed) if _is_finite_number(elapsed) and elapsed >= 0 else -1
        connected = (
            status_code is not None
            and _gpt_response_connected(target["name"], status_code)
            and elapsed_ms >= 0
        )
        if country_code in GPT_RESTRICTED_COUNTRIES and connected:
            status = "restricted"
            text = "不可访问"
            ok = False
        elif not connected:
            status = "failed"
            text = "不可访问"
            ok = False
            elapsed_ms = -1
        elif elapsed_ms < 250:
            status = "normal"
            text = "正常"
            ok = True
        elif elapsed_ms < 500:
            status = "good"
            text = "良好"
            ok = True
        else:
            status = "slow"
            text = "较慢"
            ok = True

        summaries.append(
            {
                "name": target["name"],
                "url": target["url"],
                "status": status,
                "text": text,
                "elapsed_ms": elapsed_ms,
                "ok": ok,
                "status_code": status_code,
                "error": response.get("error") if not ok else None,
            }
        )
    return summaries
