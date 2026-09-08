from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import httpx
import pytest

from backend.app.sources import coffee, gpt_checks, ipure
from backend.app.sources.coffee import (
    _global_ping_url,
    _normalize_asn,
    _profile_summary,
    _trace_ip,
)
from backend.app.sources.collector import CoffeeCollector, _completeness, _request_recorded
from backend.app.sources.gpt_checks import GPT_RESTRICTED_COUNTRIES, _gpt_check_summary
from backend.app.sources.http import (
    COFFEE_HOST,
    GLOBAL_PING_NODES,
    GPT_PROBE_TARGETS,
    IPURE_HOST,
    _validate_coffee_url,
    _validate_ipure_url,
)
from backend.app.sources.ipure import _ipure_url, _parse_ipure_scores


class StubClient:
    @asynccontextmanager
    async def stream(self, method, url, *, timeout, headers=None):
        assert method == "GET"
        response = await self.get(url, timeout=timeout)
        response.request = httpx.Request(method, url, headers=headers)
        yield response


def test_trace_ip_supports_ipv4_and_ipv6() -> None:
    assert _trace_ip("fl=1\nip=203.0.113.10\n") == "203.0.113.10"
    assert _trace_ip("ip=2001:db8::10\n") == "2001:db8::10"
    assert _trace_ip("ip=not-an-ip\n") == ""


def test_coffee_allowlist_rejects_unapproved_paths_and_queries() -> None:
    _validate_coffee_url("https://ip.net.coffee/ip/")
    _validate_coffee_url("https://ip.net.coffee/cdn-cgi/trace")
    _validate_coffee_url("https://ip.net.coffee/api/ip/lookup/203.0.113.10")
    _validate_coffee_url("https://ip.net.coffee/api/ip/portscan/203.0.113.10?probe=0")
    _validate_coffee_url(_global_ping_url("203.0.113.10"))

    for url in (
        "https://ip.net.coffee/gpt/",
        "https://ip.net.coffee/api/ip/portscan/203.0.113.10?probe=1",
        "https://ip.net.coffee/api/ping/global?host=203.0.113.10&node=n01",
        "https://example.com/ip/",
        "http://ip.net.coffee/ip/",
        "https://ip.net.coffee/ip/?next=https://example.com",
    ):
        with pytest.raises(ValueError):
            _validate_coffee_url(url)


def test_global_ping_uses_exact_fixed_node_set() -> None:
    url = _global_ping_url("2001:db8::10")
    assert "host=2001%3Adb8%3A%3A10" in url
    assert url.count("node=") == len(GLOBAL_PING_NODES)


def test_ipure_allowlist_and_score_parser_support_ipv4_and_ipv6() -> None:
    ipv4_url = _ipure_url("203.0.113.10")
    ipv6_url = _ipure_url("2001:db8::10")
    _validate_ipure_url(ipv4_url)
    _validate_ipure_url(ipv6_url)
    assert ipv4_url == "https://ipure.dev/api/lookup?ip=203.0.113.10"
    assert ipv6_url == "https://ipure.dev/api/lookup?ip=2001%3Adb8%3A%3A10"

    payload = {
        "risk": {"purity": 62},
        "scenarios": [
            {"id": "ai", "score": 51},
            {"id": "streaming", "score": 68},
            {"id": "ecommerce", "score": 53},
            {"id": "email", "score": 57},
        ],
    }
    assert _parse_ipure_scores(payload) == {
        "total": 62,
        "ai": 51,
        "streaming": 68,
        "ecommerce": 53,
        "email": 57,
    }

    for url in (
        "http://ipure.dev/api/lookup?ip=203.0.113.10",
        "https://example.com/api/lookup?ip=203.0.113.10",
        "https://ipure.dev/ip/203.0.113.10",
        "https://ipure.dev/api/lookup?ip=203.0.113.10&next=example.com",
        "https://ipure.dev/api/lookup?ip=203.0.113.10&ip=198.51.100.2",
        "https://ipure.dev/api/lookup",
    ):
        with pytest.raises(ValueError):
            _validate_ipure_url(url)


def test_gpt_check_summary_classifies_latency_and_http_failures() -> None:
    responses = [
        {
            "name": GPT_PROBE_TARGETS[0]["name"],
            "status_code": 200,
            "elapsed_ms": 100,
            "ok": True,
        },
        {
            "name": GPT_PROBE_TARGETS[1]["name"],
            "status_code": 503,
            "elapsed_ms": 999,
            "ok": False,
            "error": "HTTP 503",
        },
    ]

    checks = _gpt_check_summary(responses, {"countryCode": "US"})

    assert checks[0]["status"] == "normal"
    assert checks[0]["text"] == "正常"
    assert checks[0]["ok"] is True
    assert checks[1]["status"] == "failed"
    assert checks[1]["text"] == "不可访问"
    assert checks[1]["elapsed_ms"] == -1
    assert checks[1]["ok"] is False


def test_gpt_check_summary_marks_restricted_country_after_connection() -> None:
    responses = {
        target["name"]: {
            "status_code": 200,
            "elapsed_ms": 20,
            "ok": True,
        }
        for target in GPT_PROBE_TARGETS
    }

    checks = _gpt_check_summary(responses, {"countryCode": "CN"})

    assert {"CN", "HK", "MO", "RU", "IR", "KP", "CU", "SY"} == GPT_RESTRICTED_COUNTRIES
    assert all(check["status"] == "restricted" for check in checks)
    assert all(check["text"] == "不可访问" for check in checks)
    assert all(check["ok"] is False for check in checks)


def test_codex_probe_uses_authenticated_api_route_and_accepts_unauthorized() -> None:
    assert GPT_PROBE_TARGETS[1]["url"] == "https://api.openai.com/v1/models"
    responses = {
        GPT_PROBE_TARGETS[0]["name"]: {
            "status_code": 200,
            "elapsed_ms": 20,
            "ok": True,
        },
        GPT_PROBE_TARGETS[1]["name"]: {
            "status_code": 401,
            "elapsed_ms": 30,
            "ok": True,
        },
    }

    checks = _gpt_check_summary(responses, {"countryCode": "US"})

    assert checks[1]["status"] == "normal"
    assert checks[1]["elapsed_ms"] == 30
    assert checks[1]["ok"] is True


def test_profile_summary_normalizes_asn_aliases_and_encoded_whitespace() -> None:
    summary = _profile_summary(
        {
            "country": "Japan&#x9;",
            "region": " Tokyo\t",
            "isp": "Amazon.com&#x9; Inc.",
            "as_org": "Amazon.com&#9; Inc.",
            "asn": "ASAS16509",
            "asn_kind": "hosting&#9;",
            "rpki_status": "valid&#x9;",
            "country_code": "JP",
            "registeredCountryCode": "US",
            "is_residential": False,
            "isDatacenter": True,
        }
    )

    assert summary["location"] == "Japan Tokyo"
    assert summary["isp"] == "Amazon.com Inc."
    assert summary["as_org"] == "Amazon.com Inc."
    assert summary["asn"] == 16509
    assert summary["asn_kind_display"] == "机房/托管"
    assert summary["rpki_status"] == "✓ Valid"
    assert summary["native_status"] == "广播 IP (US)"
    assert summary["is_datacenter"] is True
    assert _normalize_asn("as as 64500") == 64500


@pytest.mark.asyncio
async def test_ipure_http_verification_is_non_blocking_enrichment(monkeypatch) -> None:
    monkeypatch.delenv("BEST_IP_IPURE_COOKIE", raising=False)

    class VerificationClient(StubClient):
        async def get(self, _url, *, timeout):
            assert timeout > 0
            return httpx.Response(403, json={"code": "verification_required"})

    collector = CoffeeCollector("http://127.0.0.1:12345", timeout_ms=1000)
    result = await ipure.request(
        collector.transport,
        VerificationClient(),
        _ipure_url("203.0.113.10"),
        timeout_seconds=1,
    )

    assert result["ok"] is False
    assert result["skipped"] is True
    assert result["error_type"] == "EnrichmentUnavailable"


@pytest.mark.asyncio
async def test_ipure_request_parses_official_lookup_response() -> None:
    class LookupClient(StubClient):
        async def get(self, url, *, timeout):
            assert url == "https://ipure.dev/api/lookup?ip=8.8.8.8"
            assert timeout > 0
            return httpx.Response(
                200,
                json={
                    "risk": {"purity": 78},
                    "scenarios": [
                        {"id": "ai", "score": 58},
                        {"id": "streaming", "score": 77},
                        {"id": "ecommerce", "score": 67},
                        {"id": "email", "score": 91},
                    ],
                    "source": "cache",
                    "stale": True,
                },
            )

    collector = CoffeeCollector("http://127.0.0.1:12345", timeout_ms=1000)
    result = await ipure.request(
        collector.transport,
        LookupClient(),
        _ipure_url("8.8.8.8"),
        timeout_seconds=1,
    )

    assert result["ok"] is True
    assert result["data"] == {
        "total": 78,
        "ai": 58,
        "streaming": 77,
        "ecommerce": 67,
        "email": 91,
    }


def test_ipure_unavailability_marks_result_incomplete() -> None:
    recorded = {"attempted": True, "status_code": 200, "ok": True}
    skipped_ipure = {
        "attempted": True,
        "status_code": 200,
        "ok": False,
        "skipped": True,
        "error_type": "EnrichmentUnavailable",
    }
    requests = {
        "page": recorded,
        "trace": recorded,
        "lookup": recorded,
        "global_ping": recorded,
        "port_scan": recorded,
        "ping_check": recorded,
        "related": recorded,
        "ipure": skipped_ipure,
    }

    completeness = _completeness(requests, "203.0.113.10", {"ip": "203.0.113.10"})

    assert completeness["complete"] is False
    assert completeness["checks"]["ipure_recorded"] is False
    assert completeness["unrecorded_requests"] == ["ipure_recorded"]


@pytest.mark.asyncio
async def test_probe_gpt_endpoint_rejects_redirect() -> None:
    Response = httpx.Response

    class Client(StubClient):
        def __init__(self) -> None:
            self.calls: list[tuple[str, httpx.Timeout]] = []

        async def get(self, url: str, *, timeout: httpx.Timeout) -> Response:
            self.calls.append((url, timeout))
            return Response(302, headers={"location": "https://example.invalid/"})

    client = Client()
    result = await gpt_checks.probe_endpoint(
        CoffeeCollector("http://127.0.0.1:12345", timeout_ms=1000).transport,
        client,
        GPT_PROBE_TARGETS[0],  # type: ignore[arg-type]
    )

    assert result["ok"] is False
    assert result["status_code"] == 302
    assert result["error_type"] == "RedirectRejected"
    assert result["elapsed_ms"] >= 0
    assert client.calls[0][0] == GPT_PROBE_TARGETS[0]["url"]
    assert client.calls[0][1].connect == 5


@pytest.mark.asyncio
async def test_collect_uses_allowlisted_sources(monkeypatch) -> None:
    requested: list[str] = []

    async def fake_request(self, _client, url, *, payload, timeout_seconds):
        requested.append(url)
        base = {
            "url": url,
            "attempted": True,
            "via_mihomo": True,
            "proxy_url": self.proxy_url,
            "target_host": COFFEE_HOST,
            "ok": True,
            "status_code": 200,
            "elapsed_ms": 2,
            "error": None,
            "error_type": None,
            "location": None,
        }
        if url.endswith("/ip/"):
            base["data"] = {"content_type": "text/html", "title": "IP"}
        elif url.endswith("/cdn-cgi/trace"):
            base["data"] = "ip=203.0.113.10\n"
        elif "/api/ip/lookup/" in url:
            base["data"] = {
                "ip": "203.0.113.10",
                "trust_score": 91,
                "country": "United States",
                "city": "Example",
                "isp": "Example ISP",
                "asn": 64500,
                "asOrganization": "Example ASN",
                "isResidential": True,
                "is_datacenter": False,
                "is_vpn": False,
                "is_proxy": False,
                "is_tor": False,
                "is_crawler": False,
                "is_abuser": False,
            }
        elif "/api/ip/portscan/" in url:
            base["data"] = {"ports": {"443": "closed"}}
        elif "/api/ip/pingcheck/" in url:
            base["data"] = {
                "verdict": "reachable",
                "reachable": True,
                "ok_nodes": 4,
                "total_nodes": 4,
            }
        elif "/api/ping/global" in url:
            base["data"] = {"results": {"n04": 20}, "timeouts": [], "pending": []}
        else:
            raise AssertionError(f"unexpected URL: {url}")
        return base

    async def fake_gpt(self, _client):
        return {
            target["name"]: {
                "name": target["name"],
                "url": target["url"],
                "status_code": 200,
                "elapsed_ms": 2,
                "ok": True,
                "error": None,
            }
            for target in GPT_PROBE_TARGETS
        }

    async def fake_ipure(self, _client, url, *, timeout_seconds):
        requested.append(url)
        return {
            "url": url,
            "attempted": True,
            "via_mihomo": True,
            "proxy_url": self.proxy_url,
            "target_host": IPURE_HOST,
            "ok": True,
            "status_code": 200,
            "elapsed_ms": 2,
            "data": {
                "total": 88,
                "ai": 81,
                "streaming": 92,
                "ecommerce": 84,
                "email": 90,
            },
            "error": None,
            "error_type": None,
            "location": None,
        }

    monkeypatch.setattr(coffee, "request", fake_request)
    monkeypatch.setattr(gpt_checks, "requests", fake_gpt)
    monkeypatch.setattr(ipure, "request", fake_ipure)
    collector = CoffeeCollector("http://127.0.0.1:12345", timeout_ms=1000)
    result = await collector.collect(
        job_id="job",
        node_index=0,
        node_name="node-a",
        node_type="vless",
        selected_proxy="node-a",
        mihomo_instance="instance",
    )

    assert result["status"] == "success"
    assert result["error"] is None
    assert result["exit_ip"] == "203.0.113.10"
    assert result["gpt_check"][0]["status"] == "normal"
    assert result["requests"]["gpt_check"] == result["gpt_check"]
    assert result["coffee"]["gpt_check"] == result["gpt_check"]
    assert result["coffee"]["lookup"]["trust_score"] == 91
    assert result["score"] == 88
    assert result["coffee_score"] == 91
    assert result["ipure_scores"]["streaming"] == 92
    assert result["bogon_status"] == "否（公网可达）"
    assert result["rdns"] == "-"
    assert result["rpki_status"] == "未知"
    assert result["asn_kind_display"] == "未知"
    assert result["security_status"] == "🛡️ 纯净 (未发现明显威胁)"
    assert result["proxy_evidence"]["direct_fallback"] is False
    assert all(
        url.startswith("https://ip.net.coffee/")
        or url.startswith("https://ipure.dev/api/lookup?ip=")
        for url in requested
    )
    forbidden_hosts = ("chatgpt", "claude", "openai", "anthropic")
    assert not any(host in " ".join(requested).lower() for host in forbidden_hosts)


@pytest.mark.asyncio
async def test_collect_overlaps_independent_coffee_requests(monkeypatch) -> None:
    active = 0
    max_active = 0

    async def fake_request(self, _client, url, *, payload, timeout_seconds):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        try:
            await asyncio.sleep(0.01)
            data = {}
            if url.endswith("/cdn-cgi/trace"):
                data = "ip=203.0.113.10\n"
            elif "/api/ip/lookup/" in url:
                data = {"ip": "203.0.113.10"}
            return {
                "url": url,
                "attempted": True,
                "via_mihomo": True,
                "proxy_url": self.proxy_url,
                "target_host": COFFEE_HOST,
                "ok": True,
                "status_code": 200,
                "elapsed_ms": 2,
                "data": data,
                "error": None,
                "error_type": None,
                "location": None,
            }
        finally:
            active -= 1

    async def fake_gpt(self, _client):
        return {
            target["name"]: {
                "name": target["name"],
                "url": target["url"],
                "status_code": 200,
                "elapsed_ms": 2,
                "ok": True,
                "error": None,
            }
            for target in GPT_PROBE_TARGETS
        }

    async def fake_ipure(self, _client, url, *, timeout_seconds):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        try:
            await asyncio.sleep(0.01)
            return {
                "url": url,
                "attempted": True,
                "via_mihomo": True,
                "proxy_url": self.proxy_url,
                "target_host": IPURE_HOST,
                "ok": True,
                "status_code": 200,
                "elapsed_ms": 2,
                "data": {
                    "total": 80,
                    "ai": 80,
                    "streaming": 80,
                    "ecommerce": 80,
                    "email": 80,
                },
                "error": None,
                "error_type": None,
                "location": None,
            }
        finally:
            active -= 1

    monkeypatch.setattr(coffee, "request", fake_request)
    monkeypatch.setattr(gpt_checks, "requests", fake_gpt)
    monkeypatch.setattr(ipure, "request", fake_ipure)
    result = await CoffeeCollector("http://127.0.0.1:12345", timeout_ms=1000).collect(
        job_id="job",
        node_index=0,
        node_name="node-a",
        node_type="ss",
        selected_proxy="node-a",
        mihomo_instance="instance",
    )

    assert result["status"] == "success"
    assert max_active >= 2


@pytest.mark.asyncio
async def test_collect_failure_has_null_exit_ip(monkeypatch) -> None:
    async def fake_request(self, _client, url, *, payload, timeout_seconds):
        return {
            "url": url,
            "attempted": True,
            "via_mihomo": True,
            "proxy_url": self.proxy_url,
            "target_host": COFFEE_HOST,
            "ok": url.endswith("/ip/"),
            "status_code": 200 if url.endswith("/ip/") else 502,
            "elapsed_ms": 1,
            "data": {"content_type": "text/html"} if url.endswith("/ip/") else None,
            "error": None if url.endswith("/ip/") else "HTTP 502",
            "error_type": None,
            "location": None,
        }

    async def unexpected_request(*_args, **_kwargs):
        raise AssertionError("出口 IP 缺失时不应继续请求 GPT 或 IPure")

    monkeypatch.setattr(coffee, "request", fake_request)
    monkeypatch.setattr(gpt_checks, "requests", unexpected_request)
    monkeypatch.setattr(ipure, "request", unexpected_request)
    result = await CoffeeCollector("http://127.0.0.1:12345", timeout_ms=1000).collect(
        job_id="job",
        node_index=0,
        node_name="node-a",
        node_type="ss",
        selected_proxy="node-a",
        mihomo_instance="instance",
    )
    assert result["status"] == "failed"
    assert result["exit_ip"] is None
    assert result["gpt_check"] == []
    assert result["completeness"]["complete"] is False


def test_collector_rejects_non_mihomo_proxy() -> None:
    with pytest.raises(ValueError):
        CoffeeCollector("http://127.0.0.1:12345/path", timeout_ms=1000)
    with pytest.raises(ValueError):
        CoffeeCollector("http://10.0.0.1:12345", timeout_ms=1000)


@pytest.mark.asyncio
async def test_request_does_not_persist_raw_connection_error() -> None:
    class FailingClient(StubClient):
        async def get(self, _url, *, timeout):
            raise httpx.ConnectError("https://user:secret@node.example:443")

    collector = CoffeeCollector("http://127.0.0.1:12345", timeout_ms=1000)
    result = await coffee.request(
        collector.transport,
        FailingClient(),
        "https://ip.net.coffee/ip/",
        payload="html",
        timeout_seconds=1,
    )

    assert result["error"] == "ConnectError"
    assert result["error_type"] == "ConnectError"
    assert "secret" not in str(result)
    assert "node.example" not in str(result)


@pytest.mark.asyncio
async def test_related_polling_stops_at_hard_time_budget(monkeypatch) -> None:
    cancelled = False

    async def fake_request(self, _client, url, *, payload, timeout_seconds):
        nonlocal cancelled
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled = True
            raise
        raise AssertionError("request should have been cancelled at the related budget")

    monkeypatch.setattr(coffee, "request", fake_request)
    collector = CoffeeCollector("http://127.0.0.1:12345", timeout_ms=100)
    loop = asyncio.get_running_loop()
    started = loop.time()
    result = await coffee.related_result(
        collector.transport,
        object(),
        "203.0.113.10",
        {"related_domains_pending": True},
    )

    assert loop.time() - started < 0.5
    assert cancelled is True
    assert result["ok"] is False
    assert result["error_type"] == "PollBudgetExceeded"
    assert result["poll_count"] == 0


def test_request_recorded_requires_successful_response() -> None:
    assert _request_recorded({"attempted": True, "status_code": 200, "ok": True})
    assert not _request_recorded({"attempted": True, "status_code": 500, "ok": False})
