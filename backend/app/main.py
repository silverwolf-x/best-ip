from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import FRONTEND_DIR, settings
from .jobs import JobNotFoundError, JobNotReadyError, job_manager
from .schemas import HealthResponse, ScanCreated, ScanRequest


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await job_manager.shutdown()


app = FastAPI(
    title="Best IP",
    version="0.1.0",
    description="经 Mihomo 本地端口逐节点查询 ip.net.coffee",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", mihomo_ready=settings.mihomo_path.is_file())


@app.post("/api/scans", response_model=ScanCreated, status_code=status.HTTP_202_ACCEPTED)
async def create_scan(request: ScanRequest) -> ScanCreated:
    return ScanCreated(**job_manager.create(request.subscription_url))


@app.get("/api/scans/{job_id}")
async def get_scan(job_id: str) -> dict[str, Any]:
    try:
        return job_manager.get(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描任务不存在") from exc


@app.get("/api/scans/{job_id}/export")
async def export_scan(job_id: str) -> dict[str, Any]:
    try:
        return job_manager.export(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描任务不存在") from exc
    except JobNotReadyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/scans/{job_id}/results/{index}")
async def get_scan_result(job_id: str, index: int) -> dict[str, Any]:
    try:
        return job_manager.get_result(job_id, index)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描结果不存在") from exc
    except JobNotReadyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.delete("/api/scans/{job_id}")
async def cancel_scan(job_id: str) -> dict[str, Any]:
    try:
        return await job_manager.cancel(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描任务不存在") from exc


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
