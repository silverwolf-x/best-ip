from __future__ import annotations

import pytest

from backend.app.scanner import (
    HttpScanner,
    _access_summary,
    _location,
    _numeric_score,
    _page_status,
    _trace_value,
)


def test_trace_value_extracts_requested_field() -> None:
    trace = "fl=29f\nh=chatgpt.com\nip=203.0.113.10\nloc=US\n"

    assert _trace_value(trace, "ip") == "203.0.113.10"
    assert _trace_value(trace, "loc") == "US"
    assert _trace_value(None, "ip") == ""


def test_page_status_combines_page_and_api_requests() -> None:
    assert _page_status({"ok": True}, {"ok": True}) == "success"
    assert _page_status({"ok": True}, {"ok": False}) == "partial"
    assert _page_status({"ok": False}, {"ok": False}) == "failed"


def test_access_summary_reports_connectivity() -> None:
    connectivity = [
        {"name": "chatgpt.com", "ok": True, "elapsed_ms": 123},
        {"name": "api.openai.com", "ok": False, "elapsed_ms": 456},
    ]

    assert _access_summary(connectivity) == (
        "chatgpt.com 可达 123ms · api.openai.com 不可达"
    )


def test_location_and_score_normalization() -> None:
    assert _location(
        {"country": "United States", "region": "CA", "city": "LA", "isp": "Example"}
    ) == "United States CA LA Example"
    assert _numeric_score(88.4) == 88
    assert _numeric_score("88") is None


@pytest.mark.asyncio
async def test_scan_node_uses_ip_lookup_as_the_only_profile_source(monkeypatch) -> None:
    scanner = HttpScanner("http://127.0.0.1:7890", timeout_ms=1000)
    requested_urls: list[str] = []
    measured_exit_ips: list[str] = []

    async def fake_request(_client, url, *, payload, any_response=False):
        requested_urls.append(url)
        response = {
            "url": url,
            "ok": True,
            "status_code": 200,
            "elapsed_ms": 25,
            "data": None,
            "error": None,
        }
        if url == "https://ip.net.coffee/cdn-cgi/trace":
            response["data"] = "ip=198.51.100.10\nloc=US\n"
        elif url == "https://chatgpt.com/cdn-cgi/trace":
            response["data"] = "ip=198.51.100.20\nloc=US\n"
        elif url == "https://claude.ai/cdn-cgi/trace":
            response["data"] = "ip=198.51.100.30\nloc=US\n"
        elif url == "https://api.openai.com/":
            response["status_code"] = 421
        elif url == "https://ip.net.coffee/api/ip/lookup/198.51.100.10":
            response["data"] = {
                "ip": "198.51.100.10",
                "trust_score": 91,
                "country": "United States",
                "region": "California",
                "city": "Los Angeles",
                "isp": "IP Lookup ISP",
                "asn": 64500,
                "asOrganization": "IP Lookup ASN",
                "isResidential": True,
                "is_datacenter": False,
                "is_bogon": False,
                "is_vpn": False,
                "is_proxy": False,
                "is_tor": False,
                "is_crawler": False,
                "is_abuser": False,
                "company_type": "isp",
            }
        elif "/api/ip/portscan/" in url:
            response["data"] = {"ports": {}}
        elif "/api/ip/pingcheck/" in url:
            response["data"] = {
                "verdict": "reachable",
                "reachable": True,
                "ok_nodes": 18,
                "total_nodes": 18,
                "ok_ratio": 1.0,
            }
        elif url not in {
            "https://ip.net.coffee/ip/",
            "https://www.anthropic.com/cdn-cgi/trace",
        }:
            raise AssertionError(f"unexpected request: {url}")
        return response

    async def fake_global_ping(_client, exit_ip):
        measured_exit_ips.append(exit_ip)
        return []

    monkeypatch.setattr(scanner, "_request", fake_request)
    monkeypatch.setattr(scanner, "_measure_global_ping", fake_global_ping)

    result = await scanner.scan_node("node-a", "vless")

    assert result["status"] == "success"
    assert result["exit_ip"] == "198.51.100.10"
    assert measured_exit_ips == ["198.51.100.10"]
    assert result["score"] == 91
    assert result["location"] == "United States California Los Angeles IP Lookup ISP"
    assert result["asn"] == 64500
    assert result["as_org"] == "IP Lookup ASN"
    assert result["is_residential"] is True
    assert result["security_status"].startswith("🛡️")
    assert "score" not in result["pages"]["gpt"]
    assert "risk" not in result["pages"]["gpt"]
    assert "geo" not in result["pages"]["claude"]
    assert not any("/api/iprisk/" in url for url in requested_urls)
    assert not any("/api/geoip/" in url for url in requested_urls)
    assert not any("status.json" in url for url in requested_urls)
    assert "https://ip.net.coffee/gpt/" not in requested_urls
    assert "https://ip.net.coffee/claude/" not in requested_urls


@pytest.mark.asyncio
async def test_global_ping_maps_coffee_node_results(monkeypatch) -> None:
    scanner = HttpScanner("http://127.0.0.1:7890", timeout_ms=1000)
    requested_urls: list[str] = []

    async def fake_request(_client, url, *, payload, any_response=False):
        requested_urls.append(url)
        return {
            "url": url,
            "ok": True,
            "status_code": 200,
            "elapsed_ms": 100,
            "data": {
                "results": {"n02": 14.4, "n03": 88},
                "timeouts": ["n01"],
                "pending": ["n04"],
            },
            "error": None,
        }

    monkeypatch.setattr(scanner, "_request", fake_request)

    result = await scanner._measure_global_ping(object(), "203.0.113.9")

    assert len(requested_urls) == 1
    assert requested_urls[0].startswith(
        "https://ip.net.coffee/api/ping/global?host=203.0.113.9&"
    )
    assert requested_urls[0].count("node=") == 8
    assert len(result) == 8
    by_node = {item["node"]: item for item in result}
    assert by_node["n02"]["elapsed_ms"] == 14
    assert by_node["n02"]["ok"] is True
    assert by_node["n01"]["status"] == "超时"
    assert by_node["n04"]["status"] == "等待结果"
    assert by_node["n09"]["status"] == "未返回"


def test_failed_node_has_profile_defaults() -> None:
    from backend.app.jobs import _failed_node

    failed = _failed_node("node-1", "vless", Exception("connection timed out"))
    assert failed["node"] == "node-1"
    assert failed["status"] == "failed"
    assert failed["score"] is None
    assert "ip_score" not in failed
    assert "gpt_score" not in failed
    assert "claude_score" not in failed
    assert failed["is_residential"] is None
    assert failed["is_datacenter"] is None
    assert failed["is_native"] is None
    assert failed["is_vpn"] is None
    assert failed["security_status"] == "检测失败"
    assert failed["asn"] is None
    assert failed["as_org"] == ""
    assert "timed out" in failed["error"]
