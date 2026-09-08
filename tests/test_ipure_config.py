import httpx
import pytest

from backend.app.sources import ipure_config
from backend.app.sources.http import ProxyTransport
from backend.app.sources.ipure import _direct_request, _ipure_url


def write_config(cookie):
    ipure_config.IPURE_CONFIG_PATH.write_text(
        f"headers:\n  Cookie: {cookie}\n  User-Agent: BrowserTest/1.0\n", encoding="utf-8"
    )


def test_yaml_overrides_environment_and_reloads(monkeypatch):
    monkeypatch.setenv("BEST_IP_IPURE_COOKIE", "environment=old")
    write_config("ipure_verified=first")
    assert ipure_config.load_ipure_headers()["cookie"] == "ipure_verified=first"
    write_config("ipure_verified=second")
    assert ipure_config.load_ipure_headers()["cookie"] == "ipure_verified=second"


def test_missing_yaml_preserves_environment(monkeypatch):
    monkeypatch.setenv("BEST_IP_IPURE_COOKIE", "ipure_verified=environment")
    assert ipure_config.load_ipure_headers()["cookie"] == "ipure_verified=environment"


@pytest.mark.parametrize(
    "content", ["headers: [secret]", "headers: {Cookie: [secret]}", "headers: [secret"]
)
def test_invalid_yaml_has_safe_error(content):
    ipure_config.IPURE_CONFIG_PATH.write_text(content, encoding="utf-8")
    with pytest.raises(ValueError) as error:
        ipure_config.load_ipure_headers()
    assert "secret" not in str(error.value)


@pytest.mark.asyncio
async def test_proxy_reads_yaml_each_time_without_leaking_to_coffee():
    cookies = []

    async def handler(request):
        cookies.append(request.headers.get("cookie"))
        return httpx.Response(200, json={})

    transport = ProxyTransport("http://127.0.0.1:12345", timeout_ms=1000)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        for cookie in ["ipure_verified=first", "ipure_verified=second"]:
            write_config(cookie)
            await transport.get(client, _ipure_url("8.8.8.8"), timeout=1)
        await transport.get(client, "https://ip.net.coffee/ip/", timeout=1)
    assert cookies == ["ipure_verified=first", "ipure_verified=second", None]


@pytest.mark.asyncio
async def test_direct_request_uses_latest_yaml(monkeypatch):
    write_config("ipure_verified=current")

    async def handler(request):
        assert request.headers["Cookie"] == "ipure_verified=current"
        assert request.headers["User-Agent"] == "BrowserTest/1.0"
        return httpx.Response(403, json={})

    client_class = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs),
    )
    assert (
        await _direct_request(
            _ipure_url("8.8.8.8"), timeout_seconds=1, verification_cookie="old=stale"
        )
        is None
    )
