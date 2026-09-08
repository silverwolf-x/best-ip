from __future__ import annotations

import asyncio
from typing import Any


async def to_thread_uncancelled(function: Any, *args: Any, **kwargs: Any) -> Any:
    operation = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(operation)
            break
        except asyncio.CancelledError:
            if operation.cancelled():
                raise
            cancelled = True
    if cancelled:
        raise asyncio.CancelledError
    return result
