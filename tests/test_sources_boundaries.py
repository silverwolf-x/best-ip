from __future__ import annotations

import asyncio
import gzip
import json

import httpx
import pytest

from backend.app.results.validation import validate_node
from backend.app.sources import coffee, ipure
from backend.app.sources.collector import CoffeeCollector
from backend.app.sources.http import (
    COFFEE_PAGE_URL,
    IPURE_MAX_RESPONSE_BYTES,
    ProxyTransport,
    ResponseTooLarge,
)
from backend.app.sources.ipure import _ipure_url, _parse_ipure_scores

SCORES = {
    "risk": {"purity": 82},
    "scenarios": [
        {"id": "ai", "score": 70},
        {"id": "streaming", "score": 80},
        {"id": "ecommerce", "score": 90},
        {"id": "email", "score": 60},
    ],
}


def collector_client(monkeypatch, handler):
    monkeypatch.setattr(
        ProxyTransport,
        "client",
        lambda self: httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            follow_redirects=False,
            trust_env=False,
        ),
    )
    return CoffeeCollector("http://127.0.0.1:12345", timeout_ms=1000)


async def collect(collector):
    return await collector.collect(
        job_id="job",
        node_index=0,
        node_name="node-a",
        node_type="ss",
        selected_proxy="node-a",
        mihomo_instance="instance",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "payload", "error_type"),
    [
        (403, {"code": "verification_required"}, "EnrichmentUnavailable"),
        (429, {}, "EnrichmentUnavailable"),
        (200, {"risk": {"purity": 82}, "scenarios": []}, "ResponseParseError"),
    ],
)
async def test_enrichment_failure_preserves_coffee_exit(
    monkeypatch,
    status_code,
    payload,
    error_type,
):
    monkeypatch.delenv("BEST_IP_IPURE_COOKIE", raising=False)

    async def handler(request):
        if request.url.host == "ipure.dev":
            return httpx.Response(status_code, json=payload)
        if request.url.path == "/cdn-cgi/trace":
            return httpx.Response(200, text="ip=203.0.113.10\n")
        if request.url.path.startswith("/api/ip/lookup/"):
            return httpx.Response(200, json={"ip": "203.0.113.10", "trust_score": 95})
        return httpx.Response(200, json={})

    result = await collect(collector_client(monkeypatch, handler))

    assert result["status"] == "partial"
    assert result["exit_ip"] == "203.0.113.10"
    assert result["score"] is None
    assert result["coffee_score"] == 95
    assert result["error"] == result["requests"]["ipure"]["error"]
    assert all(value is None for value in result["ipure_scores"].values())
    assert result["requests"]["ipure"]["error_type"] == error_type
    assert result["completeness"]["missing_required"] == []
    assert result["completeness"]["unrecorded_requests"] == ["ipure_recorded"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("statuses", "expected_delays", "expected_ok"),
    [([429, 429, 200], [1.0, 2.0], True), ([429, 429, 429], [1.0, 2.0], False), ([403], [], False)],
)
async def test_ipure_bounded_rate_limit_retry(monkeypatch, statuses, expected_delays, expected_ok):
    monkeypatch.delenv("BEST_IP_IPURE_COOKIE", raising=False)
    transport = ProxyTransport("http://127.0.0.1:12345", timeout_ms=8000)
    calls = []
    delays = []

    async def proxy_get(_client, _url, *, timeout, max_bytes):
        assert 0 < timeout <= 8
        status = statuses[len(calls)]
        calls.append(status)
        return httpx.Response(status, json=SCORES)

    async def sleep(delay):
        delays.append(delay)

    monkeypatch.setattr(transport, "get", proxy_get)
    monkeypatch.setattr(ipure.asyncio, "sleep", sleep)
    result = await ipure.request(transport, object(), _ipure_url("203.0.113.10"), timeout_seconds=8)
    assert calls == statuses
    assert delays == expected_delays
    assert result["ok"] is expected_ok


@pytest.mark.asyncio
async def test_ipure_retry_after_exceeding_budget_does_not_switch_egress(monkeypatch):
    monkeypatch.setenv("BEST_IP_IPURE_COOKIE", "ipure_session=verified")
    transport = ProxyTransport("http://127.0.0.1:12345", timeout_ms=8000)
    calls = []

    async def proxy_get(_client, _url, *, timeout, max_bytes):
        calls.append(_url)
        return httpx.Response(429, headers={"Retry-After": "60"}, json={})

    async def unexpected(*args, **kwargs):
        pytest.fail("rate limit must not trigger a direct fallback or exceed the time budget")

    monkeypatch.setattr(transport, "get", proxy_get)
    monkeypatch.setattr(ipure, "_direct_request", unexpected)
    monkeypatch.setattr(ipure.asyncio, "sleep", unexpected)
    result = await ipure.request(transport, object(), _ipure_url("203.0.113.10"), timeout_seconds=8)
    assert len(calls) == 1
    assert result["status_code"] == 429


@pytest.mark.asyncio
async def test_ipure_transport_uses_explicit_api_headers():
    async def handler(request):
        assert request.headers["Accept"] == "application/json"
        assert request.headers["User-Agent"] == "MyIPChecker/1.0"
        return httpx.Response(200, json=SCORES)

    transport = ProxyTransport("http://127.0.0.1:12345", timeout_ms=1000)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await ipure.request(
            transport,
            client,
            _ipure_url("203.0.113.10"),
            timeout_seconds=1,
        )
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_ipure_direct_request_parses_streamed_body(monkeypatch):
    class BodyStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield json.dumps(SCORES).encode()

    async def handler(request):
        assert request.url.path == "/api/lookup"
        assert request.headers["Cookie"] == "ipure_session=verified"
        return httpx.Response(200, stream=BodyStream())

    client_class = httpx.AsyncClient
    monkeypatch.setattr(
        ipure.httpx,
        "AsyncClient",
        lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs),
    )
    result = await ipure._direct_request(
        _ipure_url("203.0.113.10"),
        timeout_seconds=1,
        verification_cookie="ipure_session=verified",
    )
    assert result is not None
    assert result["ok"] is True
    assert result["data"] == {"total": 82, "ai": 70, "streaming": 80, "ecommerce": 90, "email": 60}


@pytest.mark.asyncio
async def test_ipure_direct_fallback_records_complete_scores(monkeypatch):
    monkeypatch.setenv("BEST_IP_IPURE_COOKIE", "ipure_session=verified")
    transport = ProxyTransport("http://127.0.0.1:12345", timeout_ms=1000)

    async def proxy_get(_client, _url, *, timeout, max_bytes):
        return httpx.Response(403, json={"code": "verification_required"})

    monkeypatch.setattr(transport, "get", proxy_get)
    fallback = {
        "url": _ipure_url("203.0.113.10"),
        "attempted": True,
        "status_code": 200,
        "ok": True,
        "data": {"total": 82, "ai": 70, "streaming": 80, "ecommerce": 90, "email": 60},
        "direct_fallback": True,
        "via_mihomo": False,
    }

    async def direct_request(*_args, **_kwargs):
        return fallback

    monkeypatch.setattr(ipure, "_direct_request", direct_request)

    result = await ipure.request(
        transport,
        object(),
        _ipure_url("203.0.113.10"),
        timeout_seconds=1,
    )

    assert result["ok"] is True
    assert result["data"] == fallback["data"]
    assert result["direct_fallback"] is True
    assert result["via_mihomo"] is False


@pytest.mark.asyncio
async def test_collector_accepts_verified_ipure_fallback(monkeypatch):
    monkeypatch.setenv("BEST_IP_IPURE_COOKIE", "ipure_session=verified")

    async def handler(request):
        if request.url.host == "ipure.dev":
            return httpx.Response(403, json={"code": "verification_required"})
        if request.url.path == "/cdn-cgi/trace":
            return httpx.Response(200, text="ip=203.0.113.10\n")
        if request.url.path.startswith("/api/ip/lookup/"):
            return httpx.Response(200, json={"ip": "203.0.113.10", "trust_score": 95})
        return httpx.Response(200, json={})

    fallback = {
        "url": _ipure_url("203.0.113.10"),
        "attempted": True,
        "via_mihomo": False,
        "proxy_url": None,
        "target_host": "ipure.dev",
        "ok": True,
        "status_code": 200,
        "data": {"total": 82, "ai": 70, "streaming": 80, "ecommerce": 90, "email": 60},
        "error": None,
        "error_type": None,
        "location": None,
        "skipped": False,
        "direct_fallback": True,
        "verification_session_used": True,
    }

    async def direct_request(*_args, **_kwargs):
        return fallback

    monkeypatch.setattr(ipure, "_direct_request", direct_request)
    result = await collect(collector_client(monkeypatch, handler))

    assert result["status"] == "success"
    assert result["score"] == 82
    assert result["ipure_scores"] == fallback["data"]
    assert result["proxy_evidence"]["direct_fallback"] is True
    assert result["proxy_evidence"]["ipure_verification_session_used"] is True
    validate_node("job", 0, result)


@pytest.mark.parametrize("missing", ["total", "ai", "streaming", "ecommerce", "email"])
def test_ipure_requires_total_and_every_scenario(missing):
    payload = {
        "risk": {} if missing == "total" else SCORES["risk"],
        "scenarios": [item for item in SCORES["scenarios"] if item["id"] != missing],
    }
    assert _parse_ipure_scores(payload) is None


@pytest.mark.parametrize("value", [True, "82", float("nan"), float("inf"), -1, 101])
def test_ipure_does_not_coerce_invalid_scores(value):
    assert _parse_ipure_scores({**SCORES, "risk": {"purity": value}}) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["base", "enrichment"])
async def test_collect_cancellation_drains_every_source_request(monkeypatch, phase):
    active = set()
    cancelled = set()
    ready = asyncio.Event()
    expected = 2 if phase == "base" else 7

    async def handler(request):
        if phase == "enrichment" and request.url.host == "ip.net.coffee":
            if request.url.path == "/ip/":
                return httpx.Response(200, text="<title>IP</title>")
            if request.url.path == "/cdn-cgi/trace":
                return httpx.Response(200, text="ip=203.0.113.10\n")
        url = str(request.url)
        active.add(url)
        if len(active) == expected:
            ready.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.add(url)
            raise
        finally:
            active.remove(url)

    task = asyncio.create_task(collect(collector_client(monkeypatch, handler)))
    try:
        await asyncio.wait_for(ready.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert active == set()
        assert len(cancelled) == expected
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


class ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.consumed = 0
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            self.consumed += 1
            yield chunk

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_transport_enforces_stream_size_before_reading_remaining_chunks():
    stream = ChunkStream([b"123", b"456", b"never-read"])
    transport = ProxyTransport("http://127.0.0.1:12345", timeout_ms=1000)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=stream)),
    ) as client:
        with pytest.raises(ResponseTooLarge):
            await transport.get(client, COFFEE_PAGE_URL, timeout=1, max_bytes=5)
    assert stream.consumed == 2
    assert stream.closed is True


@pytest.mark.asyncio
async def test_ipure_oversized_response_reports_bounded_failure():
    stream = ChunkStream([b"x" * IPURE_MAX_RESPONSE_BYTES, b"x", b"never-read"])
    transport = ProxyTransport("http://127.0.0.1:12345", timeout_ms=1000)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=stream)),
    ) as client:
        result = await ipure.request(
            transport, client, _ipure_url("203.0.113.10"), timeout_seconds=1
        )
    assert result["error_type"] == "ResponseTooLarge"
    assert result["status_code"] == 200
    assert result["data"] is None
    assert stream.consumed == 2
    assert stream.closed is True


@pytest.mark.asyncio
async def test_transport_preserves_decoded_gzip_payload():
    transport = ProxyTransport("http://127.0.0.1:12345", timeout_ms=1000)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                content=gzip.compress(b'{"ip":"203.0.113.10"}'),
                headers={"content-encoding": "gzip"},
            ),
        )
    ) as client:
        result = await coffee.request(
            transport,
            client,
            "https://ip.net.coffee/api/ip/lookup/203.0.113.10",
            payload="json",
            timeout_seconds=1,
        )
    assert result["ok"] is True
    assert result["data"] == {"ip": "203.0.113.10"}


@pytest.mark.asyncio
async def test_transport_hard_budget_cancels_slow_response():
    cancelled = False

    async def handler(request):
        nonlocal cancelled
        try:
            await asyncio.sleep(10)
        finally:
            cancelled = True

    transport = ProxyTransport("http://127.0.0.1:12345", timeout_ms=1000)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await coffee.request(
            transport,
            client,
            COFFEE_PAGE_URL,
            payload="html",
            timeout_seconds=0.01,
        )
    assert cancelled is True
    assert result["ok"] is False
    assert result["error_type"] == "TimeoutError"


def test_proxy_client_is_explicitly_isolated(monkeypatch):
    configuration = {}

    def factory(**kwargs):
        configuration.update(kwargs)
        return object()

    monkeypatch.setenv("HTTPS_PROXY", "http://environment.invalid:3128")
    monkeypatch.setattr(httpx, "AsyncClient", factory)
    ProxyTransport("http://127.0.0.1:12345", timeout_ms=1000).client()
    assert configuration["proxy"] == "http://127.0.0.1:12345"
    assert configuration["trust_env"] is False
    assert configuration["follow_redirects"] is False
    assert configuration["timeout"].read == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["coffee", "ipure"])
async def test_sources_reject_redirect_without_following_location(source):
    visited = []

    async def handler(request):
        visited.append(str(request.url))
        return httpx.Response(302, headers={"location": "https://untrusted.invalid/"})

    transport = ProxyTransport("http://127.0.0.1:12345", timeout_ms=1000)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
    ) as client:
        if source == "coffee":
            result = await coffee.request(
                transport,
                client,
                COFFEE_PAGE_URL,
                payload="html",
                timeout_seconds=1,
            )
        else:
            result = await ipure.request(
                transport,
                client,
                _ipure_url("203.0.113.10"),
                timeout_seconds=1,
            )
    assert result["error_type"] == "RedirectRejected"
    assert len(visited) == 1
