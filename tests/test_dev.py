from __future__ import annotations

import asyncio
import sys
import threading
import urllib.request

import pytest
from uvicorn import Config

from scripts import dev


@pytest.mark.parametrize(
    ("system", "no_reload", "expected"),
    [
        ("Windows", False, False),
        ("Windows", True, False),
        ("Linux", False, True),
        ("Linux", True, False),
    ],
)
def test_reload_policy_supports_mihomo_subprocesses(
    monkeypatch, system, no_reload, expected,
) -> None:
    monkeypatch.setattr(dev.platform, "system", lambda: system)

    assert dev._reload_enabled(no_reload) is expected


@pytest.mark.skipif(sys.platform != "win32", reason="Windows event loop regression")
def test_windows_default_uvicorn_loop_can_launch_subprocess() -> None:
    config = Config("backend.app.main:app", reload=dev._reload_enabled(False))

    async def launch_subprocess() -> None:
        process = await asyncio.create_subprocess_exec(sys.executable, "-c", "pass")
        assert await asyncio.wait_for(process.wait(), timeout=10) == 0

    with asyncio.Runner(loop_factory=config.get_loop_factory()) as runner:
        runner.run(launch_subprocess())


def test_default_port_falls_forward_when_8000_is_busy(monkeypatch, capsys) -> None:
    monkeypatch.setattr(dev, "_port_is_available", lambda _port: False)
    monkeypatch.setattr(dev, "_ephemeral_port", lambda: 18002)

    assert dev._select_port(None) == 18002
    assert "后端监听端口 8000 已占用，自动改用 18002" in capsys.readouterr().out


def test_explicit_busy_port_fails_with_actionable_message(monkeypatch) -> None:
    monkeypatch.setattr(dev, "_port_is_available", lambda _port: False)

    with pytest.raises(SystemExit, match=r"后端监听端口 8123 不可用"):
        dev._select_port(8123)


def test_frontend_port_does_not_reuse_api_port(monkeypatch) -> None:
    monkeypatch.setattr(dev, "_port_is_available", lambda _port: True)
    monkeypatch.setattr(dev, "_ephemeral_port", lambda: 15174)

    assert dev._select_port(
        None,
        default_port=5173,
        service_name="前端",
        excluded={5173},
    ) == 15174


def test_frontend_server_serves_assets_and_dynamic_api_base() -> None:
    server = dev._create_frontend_server("http://127.0.0.1:18000", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/site-config.js?v=test",
            timeout=5,
        ) as response:
            site_config = response.read().decode("utf-8")
            assert response.headers["Cache-Control"] == "no-store"
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as response:
            page = response.read().decode("utf-8")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert '"mode": "local"' in site_config
    assert '"apiBase": "http://127.0.0.1:18000"' in site_config
    assert "Best IP · 节点质量检测" in page
