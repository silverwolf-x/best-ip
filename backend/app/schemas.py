from __future__ import annotations

from pydantic import BaseModel, Field


class ScanRequest(BaseModel):
    subscription_url: str = Field(min_length=8, max_length=4096)


class ScanCreated(BaseModel):
    id: str
    status: str


class HealthResponse(BaseModel):
    status: str
    mihomo_ready: bool
