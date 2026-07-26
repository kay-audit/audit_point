"""
Зависимости для авторизации (FastAPI Depends).

Приоритет определения пользователя:
1. Сессионная cookie (aw_session) → username из auth_sessions.
2. Заголовок x-jupyterhub-user (для dev / прямой интеграции с JupyterHub).
3. Переменная окружения JUPYTERHUB_USER (dev fallback).
4. settings.jupyterhub_user (.env fallback).
"""
from __future__ import annotations

import logging
import os
import re
from typing import Optional

from fastapi import HTTPException, Request

logger = logging.getLogger("audit_workstation.api.deps.auth")


_USERNAME_DIGITS_RE = re.compile(r"^\d{5,20}$")


def _validate_username_format(raw: str) -> Optional[str]:
    """Возвращает username, если формат корректный (5-20 цифр)."""
    if not raw:
        return None
    base = raw.split("_", 1)[0]
    digits = re.sub(r"\D", "", base)
    if _USERNAME_DIGITS_RE.match(digits):
        return digits
    return None


async def _from_session(request: Request) -> Optional[str]:
    """Достаёт username из сессионной cookie через auth-домен."""
    try:
        from app.core.settings_registry import get as get_domain_settings
        from app.domains.auth.settings import AuthSettings
        from app.db.connection import get_db
        from app.domains.auth.services.auth_service import AuthService

        s = get_domain_settings("auth", AuthSettings)
        token = request.cookies.get(s.session_cookie_name)
        if not token:
            return None
        async with get_db() as conn:
            svc = AuthService(conn)
            sess = await svc.resolve_session(token)
        return sess["username"] if sess else None
    except Exception as e:
        logger.debug("session resolve failed: %s", e)
        return None


def _from_env() -> Optional[str]:
    """Извлекает username из env-var JUPYTERHUB_USER (legacy-путь для dev)."""
    try:
        raw = os.environ.get("JUPYTERHUB_USER")
        if not raw or raw == "unknown_user":
            try:
                from app.core.config import get_settings
                raw = get_settings().jupyterhub_user
            except Exception:
                raw = None
        if not raw or raw == "unknown_user":
            return None
        return _validate_username_format(raw)
    except Exception as e:
        logger.debug("env username resolve failed: %s", e)
        return None


async def get_current_username(request: Request) -> Optional[str]:
    """Возвращает username из сессии или env, или None."""
    return await _from_session(request) or _from_env()


async def get_username(request: Request) -> str:
    """
    Извлекает имя пользователя для Depends.

    Приоритет: сессионная cookie → JUPYTERHUB_USER.
    Raises HTTPException(401) если не удалось определить пользователя.
    """
    username = await get_current_username(request)
    if not username:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    return username


# Backward-compat: в некоторых местах проекта импортируется напрямую
# get_current_user_from_env из старого модуля. Здесь оставляем
# синхронную функцию для dev-режима, чтобы старые вызовы не ломались.
def get_current_user_from_env(truncate: bool = True) -> str | None:
    """Legacy: читает только из env (без сессии). Сохранён для обратной совместимости."""
    try:
        from app.core.config import get_settings
        raw = os.environ.get("JUPYTERHUB_USER") or get_settings().jupyterhub_user
    except Exception:
        raw = os.environ.get("JUPYTERHUB_USER")
    if not raw or raw == "unknown_user":
        return None
    if not truncate:
        return raw
    return _validate_username_format(raw)


# Backward-compat shim для app/api/v1/endpoints/auth.py
def extract_username_digits(raw: str) -> str:
    """Legacy-функция. Бросает HTTPException 401 если формат неверный."""
    result = _validate_username_format(raw)
    if not result:
        raise HTTPException(status_code=401, detail="Некорректный формат имени пользователя")
    return result
