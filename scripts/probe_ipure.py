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
from backend.app.sources.ipure import _ipure_scores, _parse_ipure_report  # noqa: E402

IPS = [
    "8.8.8.8",  # Google 机房
    "1.1.1.1",  # Cloudflare 任播
    "114.32.10.10",  # 中华电信 HiNet 住宅
    "49.216.1.1",  # 台湾大哥大 移动
    "101.12.1.1",  # 远传 移动
    "111.249.1.1",  # HiNet 动态
    "24.48.0.1",  # 美国住宅（Comcast/Charter 类）
    "73.1.1.1",  # Comcast 住宅
    "104.28.0.1",  # Cloudflare WARP
    "154.3.40.1",  # 常见「广播」段
    "38.180.0.1",  # 常见「广播」段
    "45.67.32.1",
    "103.149.0.1",
    "23.106.1.1",
    "2001:4860:4860::8888",  # IPv6
    "192.0.2.1",  # 文档保留段
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
        time.sleep(2)
    print("DISTINCT", {key: sorted(map(str, values)) for key, values in seen.items()})


main()
