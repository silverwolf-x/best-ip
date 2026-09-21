from __future__ import annotations

import httpx
import yaml

from ..config import ROOT_DIR

IPURE_CONFIG_PATH = ROOT_DIR / "config" / "ipure.yml"
IPURE_HEADERS = {"Accept": "application/json", "User-Agent": "MyIPChecker/1.0"}


def load_ipure_headers() -> httpx.Headers:
    """Load optional header overrides; IPure 官方接口无需 API key 或 Cookie。"""

    try:
        content = IPURE_CONFIG_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        content = ""
    except OSError:
        raise ValueError("无法读取 config/ipure.yml") from None
    try:
        config = yaml.safe_load(content) if content.strip() else {}
    except yaml.YAMLError:
        raise ValueError("config/ipure.yml 格式无效") from None
    if not isinstance(config, dict) or set(config) - {"headers"}:
        raise ValueError("config/ipure.yml 只支持 headers 配置")
    configured_headers = config.get("headers", {})
    if not isinstance(configured_headers, dict) or any(
        not isinstance(name, str)
        or not isinstance(value, str)
        or not name
        or any(character in name + value for character in "\r\n")
        for name, value in configured_headers.items()
    ):
        raise ValueError("IPure headers 必须为不含换行的字符串映射")
    headers = httpx.Headers(IPURE_HEADERS)
    headers.update(configured_headers)
    return headers
