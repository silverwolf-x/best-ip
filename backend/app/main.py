from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import settings, validate_local_frontend_origin
from .jobs import (
    JobAlreadyExistsError,
    JobNotFoundError,
    JobNotReadyError,
    job_manager,
)
from .mihomo import MihomoNotReadyError
from .schemas import HealthResponse, ScanCreated, ScanRequest


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await job_manager.shutdown()


router = APIRouter()


@router.get("/api/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    return HealthResponse(
        status="ok",
        mihomo_ready=settings.mihomo_path.is_file(),
        mode="local" if request.app.state.local_dev else "runner-api",
    )


@router.post("/api/scans", response_model=ScanCreated, status_code=status.HTTP_202_ACCEPTED)
async def create_scan(request: ScanRequest) -> ScanCreated:
    try:
        created = job_manager.create(
            request.subscription_url,
            subscription_sha256=request.subscription_sha256,
            request_id=request.request_id,
        )
    except JobAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail="扫描请求 ID 已存在") from exc
    except MihomoNotReadyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return ScanCreated(**created)


@router.get("/api/scans/{job_id}")
async def get_scan(job_id: str) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(job_manager.get, job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描任务不存在") from exc


@router.get("/api/scans/{job_id}/export")
async def export_scan(job_id: str) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(job_manager.export, job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描任务不存在") from exc
    except JobNotReadyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/api/scans/{job_id}/results/{index}")
async def get_scan_result(job_id: str, index: int) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(job_manager.get_result, job_id, index)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描结果不存在") from exc
    except JobNotReadyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete("/api/scans/{job_id}")
async def cancel_scan(job_id: str) -> dict[str, Any]:
    try:
        return await job_manager.cancel(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描任务不存在") from exc
    except JobNotReadyError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def create_app(
    *,
    local_dev: bool | None = None,
    local_frontend_origin: str | None = None,
) -> FastAPI:
    local_mode = settings.local_dev if local_dev is None else local_dev
    frontend_origin = validate_local_frontend_origin(
        settings.local_frontend_origin
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
