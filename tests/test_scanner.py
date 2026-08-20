from __future__ import annotations

import pytest

from backend.app.scanner import (
    COFFEE_HOST,
    GLOBAL_PING_NODES,
    CoffeeCollector,
    _global_ping_url,
    _trace_ip,
    _validate_coffee_url,
)


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


@pytest.mark.asyncio
async def test_collect_uses_only_coffee_urls_and_preserves_structured_payload(monkeypatch) -> None:
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

    monkeypatch.setattr(CoffeeCollector, "_request", fake_request)
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
    assert result["exit_ip"] == "203.0.113.10"
    assert result["coffee"]["lookup"]["trust_score"] == 91
    assert result["proxy_evidence"]["direct_fallback"] is False
    assert all(url.startswith("https://ip.net.coffee/") for url in requested)
    forbidden_hosts = ("chatgpt", "claude", "openai", "anthropic")
    assert not any(host in " ".join(requested).lower() for host in forbidden_hosts)


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

    monkeypatch.setattr(CoffeeCollector, "_request", fake_request)
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
    assert result["completeness"]["complete"] is False


def test_collector_rejects_non_mihomo_proxy() -> None:
    with pytest.raises(ValueError):
        CoffeeCollector("http://127.0.0.1:12345/path", timeout_ms=1000)
    with pytest.raises(ValueError):
        CoffeeCollector("http://10.0.0.1:12345", timeout_ms=1000)
