from __future__ import annotations

import os
import platform
from dataclasses import dataclass
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT_DIR / "frontend"
RUNTIME_DIR = ROOT_DIR / "runtime"
JOBS_DIR = RUNTIME_DIR / "jobs"


def _default_mihomo_path() -> Path:
    filename = "mihomo.exe" if platform.system() == "Windows" else "mihomo"
    return RUNTIME_DIR / "mihomo" / filename


@dataclass(frozen=True, slots=True)
class Settings:
    mihomo_path: Path = Path(os.getenv("BEST_IP_MIHOMO_PATH", str(_default_mihomo_path())))
    subscription_max_bytes: int = int(os.getenv("BEST_IP_SUBSCRIPTION_MAX_BYTES", 5 * 1024 * 1024))
    max_nodes: int = int(os.getenv("BEST_IP_MAX_NODES", "500"))
    max_parallel_jobs: int = int(os.getenv("BEST_IP_MAX_PARALLEL_JOBS", "2"))
    page_timeout_ms: int = int(os.getenv("BEST_IP_PAGE_TIMEOUT_MS", "45000"))
    subscription_timeout_seconds: float = float(
        os.getenv("BEST_IP_SUBSCRIPTION_TIMEOUT_SECONDS", "30")
    )


settings = Settings()

