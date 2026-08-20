from __future__ import annotations

from backend.app.scanner import (
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


def test_access_summary_reports_restriction_and_connectivity() -> None:
    connectivity = [
        {"name": "chatgpt.com", "ok": True, "elapsed_ms": 123},
        {"name": "api.openai.com", "ok": False, "elapsed_ms": 456},
    ]

    assert _access_summary(connectivity, False) == (
        "chatgpt.com 可达 123ms · api.openai.com 不可达"
    )
    assert _access_summary(connectivity, True) == "不可访问 · 地区受限"


def test_location_and_score_normalization() -> None:
    assert _location(
        {"country": "United States", "region": "CA", "city": "LA", "isp": "Example"}
    ) == "United States CA LA Example"
    assert _numeric_score(88.4) == 88
    assert _numeric_score("88") is None


def test_scanner_result_merges_network_and_risk_fields() -> None:
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
