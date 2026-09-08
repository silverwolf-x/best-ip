from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from .mihomo import MIHOMO_NOT_READY_MESSAGE, MihomoNotReadyError
from .scan.jobs import JobAlreadyExistsError, JobNotFoundError, JobNotReadyError
from .schemas import HealthResponse, ScanCreated, ScanRequest

router = APIRouter()


@router.get("/api/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    return HealthResponse(
        status="ok",
        mihomo_ready=request.app.state.scan_service.settings.mihomo_path.is_file(),
        mode="local" if request.app.state.local_dev else "runner-api",
    )


@router.post("/api/scans", response_model=ScanCreated, status_code=status.HTTP_202_ACCEPTED)
async def create_scan(payload: ScanRequest, request: Request) -> ScanCreated:
    try:
        created = request.app.state.scan_service.create(
            payload.subscription_url,
            subscription_sha256=payload.subscription_sha256,
            request_id=payload.request_id,
        )
    except JobAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail="扫描请求 ID 已存在") from exc
    except MihomoNotReadyError as exc:
        raise HTTPException(status_code=503, detail=MIHOMO_NOT_READY_MESSAGE) from exc
    return ScanCreated(**created)


@router.get("/api/scans/{job_id}")
async def get_scan(job_id: str, request: Request) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(request.app.state.scan_service.get, job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描任务不存在") from exc


@router.get("/api/scans/{job_id}/export")
async def export_scan(job_id: str, request: Request) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(request.app.state.scan_service.export, job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描任务不存在") from exc
    except JobNotReadyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/api/scans/{job_id}/results/{index}")
async def get_scan_result(job_id: str, index: int, request: Request) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(request.app.state.scan_service.get_result, job_id, index)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描结果不存在") from exc
    except JobNotReadyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete("/api/scans/{job_id}")
async def cancel_scan(job_id: str, request: Request) -> dict[str, Any]:
    try:
        return await request.app.state.scan_service.cancel(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扫描任务不存在") from exc
    except JobNotReadyError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
