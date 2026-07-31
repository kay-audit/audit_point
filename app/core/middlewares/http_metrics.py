"""Middleware записи HTTP-метрик в БД.

Raw ASGI (без BaseHTTPMiddleware) — чтобы не буферизовать тело ответа
(длинные/потоковые ответы). См. остальные middleware в ``app/core/middleware.py``.

Если service=None (фабрика отключена настройкой) — middleware вырождается
в ``time.perf_counter()`` без записи в БД, накладные расходы минимальны.
"""

from __future__ import annotations

import logging
import time
from typing import Protocol

from app.auth.dependencies import get_current_user
from app.core.config import request_id_var, get_settings
from fastapi import Request

logger = logging.getLogger("audit_workstation.middleware.http_metrics")


class HttpMetricsSink(Protocol):
    """Контракт приёмника HTTP-метрик, от которого зависит middleware.

    Реализацию (``admin.HttpMetricsService``) инжектирует composition root
    (``create_app``). Объявляем контракт в core, чтобы middleware не тянул домен
    ``admin`` в граф импорта на уровне модуля (плагин-симметрия доменов)."""

    async def record(
        self,
        *,
        method: str,
        path: str,
        status_code: int,
        latency_ms: int,
        username: str | None,
        request_id: str | None,
    ) -> None: ...

# Пути, для которых метрики не пишутся (мусор в журнале).
_SKIP_PREFIXES: tuple[str, ...] = ("/static/", "/health")

# Жёсткий лимит длины path — защита от переполнения VARCHAR(512).
_PATH_MAX_LEN = 512


def _should_skip(path: str) -> bool:
    """Проверяет, нужно ли пропустить запись метрики для данного пути."""
    return any(path.startswith(p) for p in _SKIP_PREFIXES)


class HttpMetricsMiddleware:
    """Записывает latency / status каждого HTTP-запроса в БД."""

    def __init__(self, app, service: HttpMetricsSink | None = None):
        self.app = app
        self._service = service

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path") or ""
        if _should_skip(path):
            await self.app(scope, receive, send)
            return

        start = time.perf_counter()
        status_holder: dict[str, int] = {"code": 0}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_holder["code"] = int(message.get("status", 0))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            if self._service is not None:
                elapsed_ms = int((time.perf_counter() - start) * 1000)
                method = scope.get("method", "")
                trimmed_path = path[:_PATH_MAX_LEN]
            # Username берём из контекста запроса
            # Может быть None — это валидно для unauthenticated.
            try:
                scope = scope  # access to outer scope
                request = Request(scope)
                user = await get_current_user(request)

                # Если возвращен RedirectResponse, устанавливаем username в None
                if hasattr(user, "status_code") and user.status_code == 307:
                    username = None
                else:
                    username = user.login if user else None
            except Exception:
                username = None
                request_id = request_id_var.get()
                if request_id == "-":
                    request_id = None
                await self._service.record(
                    method=method,
                    path=trimmed_path,
                    status_code=status_holder["code"],
                    latency_ms=elapsed_ms,
                    username=username,
                    request_id=request_id,
                )
