from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, TypedDict

from .errors import ScanError


class NodeRecord(TypedDict):
    schema_version: int
    job_id: str
    node_index: int
    node: str
    type: str
    status: Literal["success", "partial", "failed"]
    error: str | None
    exit_ip: str | None
    selected_proxy: str | None
    started_at: str
    finished_at: str
    proxy_evidence: dict[str, Any]
    completeness: dict[str, Any]
    requests: dict[str, Any]
    coffee: dict[str, Any]
    phase: NotRequired[str]
    attempt_count: NotRequired[int]
    retry_count: NotRequired[int]
    attempt_errors: NotRequired[list[str]]


class ScanProgress(TypedDict):
    job_id: str
    status: str | None
    phase: str | None
    total: int
    skipped: int
    completed: int
    success_count: int
    partial_count: int
    failed_count: int
    current_node: str | None
    manifest_ready: bool
    cleanup_confirmed: bool
    updated_at: str
    error: str | None


@dataclass(slots=True)
class NodeOutcome:
    record: NodeRecord
    phase_ms: dict[str, int] = field(default_factory=dict)
    error: ScanError | None = None
