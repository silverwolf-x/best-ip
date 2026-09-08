from __future__ import annotations

import re
from html import unescape
from math import isfinite
from typing import Any


def _clean_text(value: Any, *, default: str = "") -> str:
    text = unescape(str(value or ""))
    normalized = re.sub(r"\s+", " ", text).strip()
    return normalized or default


def _is_finite_number(value: Any) -> bool:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return False
    try:
        return isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _numeric_score(value: Any) -> int | None:
    if _is_finite_number(value) and 0 <= value <= 100:
        return round(value)
    return None
