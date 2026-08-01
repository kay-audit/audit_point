"""
Зависимости авторизации API.

ОТП-режим (AUTH__ENABLED=true): username = sub из JWT, который AuthMiddleware
кладёт в scope["state"]["user"]. Похода в БД нет — sub и есть username справочника
пользователей. Роли и профиль запрашиваются только там, где нужны.

Тест-режим (AUTH__ENABLED=false): username из окружения (JUPYTERHUB_USER) —
для pytest/Playwright-харнесса и локальной отладки.
"""

import logging

from fastapi import HTTPException, Request

from app.auth.context import resolve_env_username
from app.core.config import get_settings

logger = logging.getLogger("audit_workstation.api.deps.auth")


async def get_username(request: Request) -> str:
    """
    Возвращает username текущего пользователя.

    Returns:
        Username (табельный номер из справочника)

    Raises:
        HTTPException: 401 если пользователь не авторизован
    """
    if not get_settings().auth.enabled:
        username = resolve_env_username()
        if not username:
            raise HTTPException(
                status_code=401,
                detail="Требуется авторизация"
            )
        return username

    user_data = request.scope.get("state", {}).get("user") or {}
    username = user_data.get("sub")
    if not username:
        raise HTTPException(status_code=401, detail="Не авторизован")
    return username
