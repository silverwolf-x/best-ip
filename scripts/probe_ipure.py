"""临时诊断（跑完即删）：在 Actions runner 上对一组不同类型的 IP 实查 IPure /api/lookup，
打印原始字段与本仓库解析器的结果，用来校准 usageType / nativeType 等取值。"""

from __future__ import annotations

import html
import json
import re
import sys
import time

import httpx

sys.path.insert(0, ".")
from backend.app.sources.collector import _network_identity  # noqa: E402
from backend.app.sources.ipure import _ipure_scores, _parse_ipure_report  # noqa: E402

IPS = [
    "8.8.8.8",  # Google 机房（已缓存）
    "114.32.10.10",  # HiNet 住宅（已缓存）
    "49.216.1.1",  # 台湾大哥大 移动（已缓存）
    "2001:4860:4860::8888",  # 广播（已缓存）
    "192.0.2.1",  # 保留段（已缓存）
    "129.105.0.1",  # 美国高校 → education？
    "137.82.0.1",  # 加拿大高校 → education？
    "164.100.1.1",  # 印度 NIC → government？
]

HEADERS = {"Accept": "application/json", "User-Agent": "MyIPChecker/1.0"}


def docs() -> None:
    try:
        response = httpx.get(
            "https://ipure.dev/docs/api", headers={"User-Agent": "Mozilla/5.0"}, timeout=30
        )
    except httpx.HTTPError as exc:
        print("docs error", exc)
        return
    raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", response.text)
    text = html.unescape(re.sub(r"(?s)<[^>]+>", "\n", raw))
    text = re.sub(r"\n\s*\n+", "\n", text)
    print(f"docs http={response.status_code} chars={len(text)}")
    for word in ("usageType", "nativeType", "geo", "asn", "registry", "flags", "level"):
        for match in re.finditer(word, text):
            start = max(0, match.start() - 200)
            print(f"--- docs[{word}] ...{text[start : match.end() + 400]!r}")
            break
    # 脚本内嵌的 JSON / 枚举也扫一遍
    for word in ("usageType", "nativeType"):
        found = sorted(set(re.findall(rf"{word}[^\n]{{0,200}}", response.text)))[:8]
        print(f"=== raw[{word}]", found)


def main() -> None:
    docs()
    seen: dict[str, set] = {"usageType": set(), "nativeType": set()}
    for ip in IPS:
        try:
            response = httpx.get(
                "https://ipure.dev/api/lookup", params={"ip": ip}, headers=HEADERS, timeout=40
            )
        except httpx.HTTPError as exc:
            print(f"===== {ip} error {exc!r}")
            continue
        budget = response.headers.get("x-open-budget-remaining")
        try:
            payload = response.json()
        except ValueError:
            print(f"===== {ip} http={response.status_code} non-json {response.text[:200]!r}")
            continue
        print(f"===== {ip} http={response.status_code} budget={budget}")
        if not response.is_success:
            print(json.dumps(payload, ensure_ascii=False)[:600])
            time.sleep(2)
            continue
        for key in seen:
            seen[key].add(payload.get(key))
        view = {
            "ip": payload.get("ip"),
            "geo": payload.get("geo"),
            "asn": payload.get("asn"),
            "registry": {
                k: (payload.get("registry") or {}).get(k) for k in ("org", "country", "netName")
            },
            "usageType": payload.get("usageType"),
            "nativeType": payload.get("nativeType"),
            "flags": payload.get("flags"),
            "cloud": payload.get("cloud"),
            "risk": {k: (payload.get("risk") or {}).get(k) for k in ("purity", "level", "label")},
            "factor_ids": [
                f.get("id")
                for f in (payload.get("risk") or {}).get("factors", [])
                if isinstance(f, dict)
            ],
            "top_keys": sorted(payload),
        }
        print("raw   ", json.dumps(view, ensure_ascii=False))
        report = _parse_ipure_report(payload)
        print("parsed", json.dumps(report and report.get("network"), ensure_ascii=False))
        print("scores", json.dumps(_ipure_scores({"data": report}), ensure_ascii=False))
        identity = _network_identity(ip, report and report.get("network"), {}, {})
        print("record", json.dumps(identity, ensure_ascii=False))
        time.sleep(2)
    print("DISTINCT", {key: sorted(map(str, values)) for key, values in seen.items()})


main()
