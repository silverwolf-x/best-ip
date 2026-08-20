from __future__ import annotations

import pytest

from backend.app.subscription import SubscriptionError, parse_subscription, validate_public_url


def test_parse_mihomo_yaml_subscription() -> None:
    content = b"""
proxies:
  - name: node-a
    type: ss
    server: example.com
    port: 443
    cipher: aes-128-gcm
    password: secret
  - name: node-b
    type: trojan
    server: example.net
    port: 443
    password: secret
"""

    proxies = parse_subscription(content, max_nodes=10)

    assert [proxy["name"] for proxy in proxies] == ["node-a", "node-b"]
    assert proxies[1]["type"] == "trojan"


@pytest.mark.parametrize(
    "content,message",
    [
        (b"proxy-groups: []", "proxies"),
        (b"proxies: []", "没有节点"),
        (
            b"proxies:\n  - name: duplicate\n    type: ss\n"
            b"  - name: duplicate\n    type: vmess",
            "重名",
        ),
        (b"proxies:\n  - name: no-type", "缺少有效类型"),
    ],
)
def test_parse_subscription_rejects_invalid_documents(content: bytes, message: str) -> None:
    with pytest.raises(SubscriptionError, match=message):
        parse_subscription(content, max_nodes=10)


def test_parse_subscription_rejects_over_limit() -> None:
    content = b"proxies:\n  - {name: a, type: ss}\n  - {name: b, type: ss}\n"

    with pytest.raises(SubscriptionError, match="超过上限"):
        parse_subscription(content, max_nodes=1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/subscription",
        "http://[::1]/subscription",
        "http://localhost/subscription",
        "file:///tmp/subscription",
    ],
)
async def test_validate_public_url_blocks_local_targets(url: str) -> None:
    with pytest.raises(SubscriptionError):
        await validate_public_url(url)


@pytest.mark.asyncio
async def test_validate_real_test_subscription_url() -> None:
    test_url = "https://sub.nekocloud.host/nekocloud/token=/05d194d5a0f47593060b9fe951a6313b"
    await validate_public_url(test_url)
