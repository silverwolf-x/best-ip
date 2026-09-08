from __future__ import annotations

import argparse
import asyncio
import hashlib
import math
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

ERRORS = {
    "input_invalid": (2, "扫描输入或运行身份无效"),
    "environment_not_ready": (3, "扫描运行环境未就绪"),
    "scan_unavailable": (4, "扫描没有可用节点结果"),
    "result_invalid": (5, "扫描产物校验失败"),
    "scan_timeout": (6, "扫描超过总时间预算，已请求取消"),
    "cleanup_failed": (7, "扫描资源清理未确认，未发布产物"),
    "output_failed": (8, "无法安全发布扫描产物"),
    "scan_cancelled": (130, "扫描已取消，未发布产物"),
}


class ScanCLIError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        self.exit_code, message = ERRORS[code]
        super().__init__(message)


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ScanCLIError("input_invalid")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = SafeArgumentParser(description="Run the shared scan core without an HTTP server")
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--subscription-file", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--run-id", type=int)
    parser.add_argument("--run-attempt", type=int)
    parser.add_argument("--local-test", action="store_true")
    parser.add_argument("--timeout", type=float, default=1500)
    return parser.parse_args(argv)


def _validate_args(args: argparse.Namespace) -> None:
    if (
        not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", args.request_id)
        or not math.isfinite(args.timeout)
        or args.timeout <= 0
    ):
        raise ScanCLIError("input_invalid")
    if args.local_test and os.environ.get("GITHUB_ACTIONS", "").lower() == "true":
        raise ScanCLIError("input_invalid")
    for name, environment in (("run_id", "GITHUB_RUN_ID"), ("run_attempt", "GITHUB_RUN_ATTEMPT")):
        explicit = getattr(args, name)
        raw = os.environ.get(environment)
        try:
            inherited = int(raw) if raw is not None else None
        except ValueError as exc:
            raise ScanCLIError("input_invalid") from exc
        if explicit is not None and inherited is not None and explicit != inherited:
            raise ScanCLIError("input_invalid")
        value = explicit if explicit is not None else inherited
        if value is None and args.local_test:
            value = 1
        if type(value) is not int or value < 1:
            raise ScanCLIError("input_invalid")
        setattr(args, name, value)


def _read_subscription_url(path: Path) -> str:
    try:
        with path.open("rb") as source:
            raw = source.read(4097)
        if len(raw) > 4096:
            raise ValueError
        url = raw.decode("utf-8").strip()
        parsed = urlsplit(url)
        if (
            not 8 <= len(url) <= 4096
            or parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or any(character.isspace() for character in url)
        ):
            raise ValueError
        _ = parsed.port
        return url
    except (OSError, UnicodeError, ValueError) as exc:
        raise ScanCLIError("input_invalid") from exc


def _remove_owned(path: Path) -> None:
    if path.is_symlink() or path.resolve() != path or not path.is_absolute():
        raise ScanCLIError("cleanup_failed")
    try:
        shutil.rmtree(path)
    except OSError as exc:
        raise ScanCLIError("cleanup_failed") from exc


async def _shutdown(manager: Any, job_id: str | None, cancel: bool) -> None:
    failed = False
    if cancel and job_id is not None:
        try:
            await manager.cancel(job_id)
        except Exception:
            failed = True
    try:
        await manager.shutdown()
    except Exception:
        failed = True
    if failed:
        raise ScanCLIError("cleanup_failed")


async def _confirmed_shutdown(manager: Any, job_id: str | None, cancel: bool) -> None:
    operation = asyncio.create_task(_shutdown(manager, job_id, cancel))
    interrupted = False
    while not operation.done():
        try:
            await asyncio.shield(operation)
        except asyncio.CancelledError:
            interrupted = True
    operation.result()
    if interrupted:
        raise asyncio.CancelledError


def _publish(output: Path, result: bytes, status: bytes) -> None:
    staging = None
    try:
        if output.exists() or output.is_symlink():
            raise ScanCLIError("output_failed")
        output.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=".best-ip-artifact-", dir=output.parent)).resolve()
        (staging / "result.json").write_bytes(result)
        (staging / "status.json").write_bytes(status)
        if output.exists() or output.is_symlink():
            raise ScanCLIError("output_failed")
        staging.rename(output)
        staging = None
    except OSError as exc:
        raise ScanCLIError("output_failed") from exc
    finally:
        if staging is not None:
            _remove_owned(staging)


async def run(
    args: argparse.Namespace,
    *,
    app_settings: Any = None,
    manager_factory: Any = None,
    download: Any = None,
) -> None:
    _validate_args(args)
    url = _read_subscription_url(args.subscription_file)
    output = args.output_dir.absolute()
    if output.exists() or output.is_symlink():
        raise ScanCLIError("output_failed")
    try:
        from backend.app.config import settings
        from backend.app.mihomo import MihomoNotReadyError
        from backend.app.results.artifact import (
            build_artifact,
            credential_values,
            subscription_url_values,
        )
        from backend.app.results.store import ResultStore, ResultStoreError
        from backend.app.scan.jobs import JobNotReadyError, ScanJobManager
        from backend.app.subscription import SubscriptionError, download_subscription
    except Exception as exc:
        raise ScanCLIError("environment_not_ready") from exc
    app_settings = app_settings or settings
    manager_factory = manager_factory or ScanJobManager
    download = download or download_subscription
    owned = None
    manager = None
    job_id = None
    completed = False
    try:
        async with asyncio.timeout(args.timeout):
            try:
                content = await download(
                    url,
                    max_bytes=app_settings.subscription_max_bytes,
                    timeout_seconds=min(app_settings.subscription_timeout_seconds, args.timeout),
                )
            except (SubscriptionError, ValueError) as exc:
                raise ScanCLIError("input_invalid") from exc
            if not isinstance(content, bytes) or len(content) > app_settings.subscription_max_bytes:
                raise ScanCLIError("input_invalid")

            async def snapshot_loader(
                requested_url: str, *, max_bytes: int, timeout_seconds: float
            ) -> bytes:
                if requested_url != url or len(content) > max_bytes or timeout_seconds <= 0:
                    raise SubscriptionError("订阅快照无效")
                return content

            owned = Path(tempfile.mkdtemp(prefix="best-ip-scan-")).resolve()
            manager = manager_factory(
                app_settings,
                ResultStore(owned / "results"),
                owned / "jobs",
                download=snapshot_loader,
            )
            manager.create(
                url,
                subscription_sha256=hashlib.sha256(content).hexdigest(),
                request_id=args.request_id,
            )
            job_id = args.request_id
            job = await manager.wait(job_id)
            if job.get("cleanup_confirmed") is not True:
                raise ScanCLIError("cleanup_failed")
            if job.get("status") != "completed":
                failure = manager.get_error(job_id)
                code = failure.code if failure is not None else None
                if code == "subscription_invalid":
                    code = "input_invalid"
                if code not in ERRORS:
                    code = (
                        "scan_cancelled"
                        if job.get("status") == "cancelled"
                        else "scan_unavailable"
                    )
                raise ScanCLIError(code)
            if job.get("manifest_ready") is not True:
                raise ScanCLIError("result_invalid")
            exported = manager.export(job_id)
            forbidden = {url, *credential_values(content), *subscription_url_values(url)}
            result, status = build_artifact(
                exported, job_id, args.run_id, args.run_attempt, forbidden
            )
            counts = exported["manifest"]["counts"]
            if counts["success"] + counts["partial"] < 1:
                raise ScanCLIError("scan_unavailable")
            completed = True
    except TimeoutError as exc:
        raise ScanCLIError("scan_timeout") from exc
    except MihomoNotReadyError as exc:
        raise ScanCLIError("environment_not_ready") from exc
    except (ResultStoreError, JobNotReadyError) as exc:
        raise ScanCLIError("result_invalid") from exc
    except ScanCLIError:
        raise
    except Exception as exc:
        raise ScanCLIError("scan_unavailable") from exc
    finally:
        if manager is not None:
            await _confirmed_shutdown(manager, job_id, not completed)
        if owned is not None:
            _remove_owned(owned)
    _publish(output, result, status)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        asyncio.run(run(args))
    except (KeyboardInterrupt, asyncio.CancelledError):
        failure = ScanCLIError("scan_cancelled")
    except ScanCLIError as exc:
        failure = exc
    except Exception:
        failure = ScanCLIError("environment_not_ready")
    else:
        print("scan_completed: 已确认清理并发布脱敏扫描产物")
        return 0
    print(f"{failure.code}: {failure}", file=sys.stderr)
    return failure.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
