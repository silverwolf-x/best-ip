from __future__ import annotations

from pydantic import BaseModel, Field

_REQUEST_ID_PATTERN = r"^[A-Za-z0-9_-]{1,128}$"


class ScanRequest(BaseModel):
    subscription_url: str = Field(min_length=8, max_length=4096)
    subscription_sha256: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )
    request_id: str | None = Field(
        default=None,
        pattern=_REQUEST_ID_PATTERN,
    )


class ScanCreated(BaseModel):
    id: str
    status: str


class HealthResponse(BaseModel):
    status: str
    mihomo_ready: bool
