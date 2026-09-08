from __future__ import annotations

import os

import pytest

from backend.app.subscription import download_subscription, parse_subscription


@pytest.mark.integration
@pytest.mark.asyncio
async def test_real_subscription_download_and_parse() -> None:
    if os.getenv("RUN_REAL_SUBSCRIPTION") != "1":
        pytest.skip("set RUN_REAL_SUBSCRIPTION=1 to run against the live subscription")
    subscription_url = os.getenv("BEST_IP_REAL_SUBSCRIPTION_URL", "").strip()
    if not subscription_url:
        pytest.fail("BEST_IP_REAL_SUBSCRIPTION_URL is required for the live subscription test")
    content = await download_subscription(
        subscription_url,
        max_bytes=5_000_000,
        timeout_seconds=20,
    )
    nodes = parse_subscription(content, max_nodes=500)
    assert content
    assert nodes
    assert any(node.get("type") not in {"direct", "reject"} for node in nodes)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_real_subscription_complete_local_flow() -> None:
    if os.getenv("RUN_REAL_LOCAL_SCAN") != "1":
        pytest.skip("set RUN_REAL_LOCAL_SCAN=1 with a running local API to run the full scan")
    from scripts.verify_real_scan import verify

    await verify()
