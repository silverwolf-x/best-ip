from __future__ import annotations

import pytest

from backend.app.subscription import (
    SubscriptionError,
    parse_subscription,
    validate_public_url,
)


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
            "名称重复",
        ),
        (b"proxies:\n  - name: no-type", "缺少有效类型"),
        (b"proxies:\n  - {name: direct, type: direct}", "直连/拒绝"),
        (b"proxies:\n  - {name: reject, type: reject}", "直连/拒绝"),
    ],
)
def test_parse_subscription_rejects_invalid_documents(content: bytes, message: str) -> None:
    with pytest.raises(SubscriptionError, match=message):
        parse_subscription(content, max_nodes=10)


def test_parse_subscription_errors_do_not_echo_node_name() -> None:
    content = b"proxies:\n  - name: credential-secret-value"

    with pytest.raises(SubscriptionError) as caught:
        parse_subscription(content, max_nodes=10)

    assert "credential-secret-value" not in str(caught.value)


def test_parse_subscription_rejects_over_limit() -> None:
    content = b"proxies:\n  - {name: a, type: ss}\n  - {name: b, type: ss}\n"
    with pytest.raises(SubscriptionError, match="超过上限"):
        parse_subscription(content, max_nodes=1)


def test_subscription_metadata_does_not_consume_node_limit() -> None:
    content = """
proxies:
  - name: node-a
    type: ss
  - name: 剩余流量：500 GB
  - name: 套餐到期：2026-11-01
""".encode()
    proxies = parse_subscription(content, max_nodes=1)
    assert [proxy["name"] for proxy in proxies] == [
        "node-a",
        "剩余流量：500 GB",
        "套餐到期：2026-11-01",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/subscription",
        "http://[::1]/subscription",
        "http://localhost/subscription",
        "file:///tmp/subscription",
        "https://user:pass@example.com/subscription",
    ],
)
async def test_validate_public_url_blocks_local_or_credential_targets(url: str) -> None:
    with pytest.raises(SubscriptionError):
        await validate_public_url(url)
