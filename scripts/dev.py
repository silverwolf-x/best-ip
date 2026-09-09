from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT_DIR = Path(__file__).resolve().parents[1]
MIHOMO_TAG = "v1.19.30"
LOCAL_HOST = "127.0.0.1"
DEFAULT_API_PORT = 8000
DEFAULT_FRONTEND_PORT = 5173
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


def _default_mihomo_path() -> Path:
    filename = "mihomo.exe" if platform.system() == "Windows" else "mihomo"
    return ROOT_DIR / "runtime" / "mihomo" / filename


def _ensure_mihomo() -> Path:
    configured = os.getenv("BEST_IP_MIHOMO_PATH", "").strip()
    path = Path(configured).expanduser().resolve() if configured else _default_mihomo_path()
    if path.is_file():
        return path
    if configured:
        raise SystemExit(f"BEST_IP_MIHOMO_PATH 指向的文件不存在：{path}")
    print(f"首次启动：正在安装 Mihomo {MIHOMO_TAG} ...", flush=True)
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT_DIR / "scripts" / "download_mihomo.py"),
            "--tag",
            MIHOMO_TAG,
        ],
        cwd=ROOT_DIR,
        check=False,
    )
    if result.returncode:
        raise SystemExit(
            "Mihomo 自动安装失败；请检查上述下载错误后重试，"
            "或设置 BEST_IP_MIHOMO_PATH 指向已安装的核心。"
        )
    if not path.is_file():
        raise SystemExit(f"Mihomo 安装完成后仍未找到：{path}")
    return path


def _open_when_ready(frontend_url: str, api_url: str) -> None:
    health_url = f"{api_url}/api/health"
    for _ in range(100):
        try:
            with urllib.request.urlopen(health_url, timeout=1) as response:
                api_ready = response.status == 200
            with urllib.request.urlopen(frontend_url, timeout=1) as response:
                frontend_ready = response.status == 200
            if api_ready and frontend_ready:
                webbrowser.open(frontend_url)
                return
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)


def _port_is_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            sock.bind((LOCAL_HOST, port))
        except OSError:
            return False
    return True


def _ephemeral_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind((LOCAL_HOST, 0))
        return int(sock.getsockname()[1])


def _select_port(
    requested_port: int | None,
    *,
    default_port: int = DEFAULT_API_PORT,
    service_name: str = "后端",
    excluded: set[int] | None = None,
) -> int:
    excluded_ports = excluded or set()
    if requested_port is not None:
        if requested_port in excluded_ports or not _port_is_available(requested_port):
            raise SystemExit(
                f"{service_name}监听端口 {requested_port} 不可用；请停止占用进程或更换端口。"
            )
        return requested_port

    if default_port not in excluded_ports and _port_is_available(default_port):
        return default_port
    port = _ephemeral_port()
    while port in excluded_ports:
        port = _ephemeral_port()
    print(f"{service_name}监听端口 {default_port} 已占用，自动改用 {port}。", flush=True)
    return port


def _create_frontend_server(api_url: str, port: int) -> ThreadingHTTPServer:
    site_config = (
        "window.BEST_IP_CONFIG = Object.freeze("
        f"{json.dumps({'mode': 'local', 'apiBase': api_url}, ensure_ascii=False)}"
        ");\n"
    ).encode()

    class FrontendHandler(SimpleHTTPRequestHandler):
        def do_GET(self) -> None:
            if urlsplit(self.path).path == "/site-config.js":
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(site_config)))
                self.end_headers()
                self.wfile.write(site_config)
                return
            super().do_GET()

        def log_message(self, _format: str, *_args: object) -> None:
            return

    handler = partial(FrontendHandler, directory=str(ROOT_DIR / "frontend"))
    return ThreadingHTTPServer((LOCAL_HOST, port), handler)


def _reload_enabled(no_reload: bool) -> bool:
    if no_reload:
        return False
    if platform.system() == "Windows":
        print("Windows 下已关闭后端热重载，以支持启动 Mihomo 子进程。", flush=True)
        return False
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="启动 Best IP 本地前后端调试服务")
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="后端 API 端口（默认 8000，占用时自动选择空闲端口）",
    )
    parser.add_argument(
        "--frontend-port",
        type=int,
        default=None,
        help="前端静态服务端口（默认 5173，占用时自动选择空闲端口）",
    )
    parser.add_argument("--no-reload", action="store_true", help="关闭后端代码热重载")
    parser.add_argument("--no-open", action="store_true", help="不自动打开默认浏览器")
    args = parser.parse_args()
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error("--port 必须在 1 到 65535 之间")
    if args.frontend_port is not None and not 1 <= args.frontend_port <= 65535:
        parser.error("--frontend-port 必须在 1 到 65535 之间")

    reload_enabled = _reload_enabled(args.no_reload)
    api_port = _select_port(args.port)
    frontend_port = _select_port(
        args.frontend_port,
        default_port=DEFAULT_FRONTEND_PORT,
        service_name="前端",
        excluded={api_port},
    )
    mihomo_path = _ensure_mihomo()
    api_url = f"http://{LOCAL_HOST}:{api_port}"
    frontend_url = f"http://{LOCAL_HOST}:{frontend_port}"
    os.environ["BEST_IP_LOCAL_DEV"] = "1"
    os.environ["BEST_IP_MIHOMO_PATH"] = str(mihomo_path)
    os.environ["BEST_IP_LOCAL_FRONTEND_ORIGIN"] = frontend_url
    frontend_server = _create_frontend_server(api_url, frontend_port)
    frontend_thread = threading.Thread(
        target=frontend_server.serve_forever,
        name="best-ip-frontend",
        daemon=True,
    )
    frontend_thread.start()
    if not args.no_open:
        threading.Thread(
            target=_open_when_ready,
            args=(frontend_url, api_url),
            daemon=True,
        ).start()

    print(f"Best IP 前端：{frontend_url}", flush=True)
    print(f"Best IP 后端 API：{api_url}", flush=True)
    print("前后端均仅监听 127.0.0.1；按 Ctrl+C 统一停止。", flush=True)
    import uvicorn

    try:
        uvicorn.run(
            "backend.app.main:app",
            host=LOCAL_HOST,
            port=api_port,
            reload=reload_enabled,
            reload_dirs=[str(ROOT_DIR / "backend")] if reload_enabled else None,
        )
    finally:
        frontend_server.shutdown()
        frontend_server.server_close()
        frontend_thread.join(timeout=5)


if __name__ == "__main__":
    main()
