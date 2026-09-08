from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import router
from .config import JOBS_DIR, RESULTS_DIR, Settings, settings, validate_local_frontend_origin
from .results.store import ResultStore
from .scan.jobs import ScanJobManager


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    try:
        yield
    finally:
        await application.state.scan_service.shutdown()


def create_app(
    *,
    app_settings: Settings = settings,
    result_store: ResultStore | None = None,
    workspace: Path = JOBS_DIR,
    scan_service: ScanJobManager | None = None,
    local_dev: bool | None = None,
    local_frontend_origin: str | None = None,
) -> FastAPI:
    local_mode = app_settings.local_dev if local_dev is None else local_dev
    frontend_origin = validate_local_frontend_origin(
        app_settings.local_frontend_origin
        if local_frontend_origin is None
        else local_frontend_origin
    )
    application = FastAPI(
        title="Best IP",
        version="0.1.0",
        description="经 Mihomo 本地端口逐节点查询 Coffee 与 IPure",
        lifespan=lifespan,
    )
    application.state.local_dev = local_mode
    application.state.scan_service = scan_service or ScanJobManager(
        app_settings,
        result_store if result_store is not None else ResultStore(RESULTS_DIR),
        workspace,
    )
    application.add_exception_handler(
        RequestValidationError,
        lambda _request, _exc: JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={"detail": "请求参数无效"},
        ),
    )
    if local_mode and frontend_origin:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=[frontend_origin],
            allow_credentials=False,
            allow_methods=["GET", "POST", "DELETE"],
            allow_headers=["Accept", "Content-Type"],
        )
    application.include_router(router)

    if local_mode:

        @application.middleware("http")
        async def disable_local_cache(request: Request, call_next):
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store"
            return response

    return application


app = create_app()
