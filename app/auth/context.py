"""Контекст авторизации текущего запроса (username из JWT)."""

from contextvars import ContextVar

_request_username: ContextVar[str | None] = ContextVar("_request_username", default=None)


def set_request_username(username: str | None) -> None:
    """Сохраняет username аутентифицированного пользователя для текущего запроса."""
    _request_username.set(username)


def get_request_username() -> str | None:
    """Возвращает username из JWT-контекста или None."""
    return _request_username.get()


def resolve_env_username() -> str | None:
    """Username для тест-режима (AUTH__ENABLED=false): из окружения, только цифры.

    Имя переменной JUPYTERHUB_USER — историческое; в тест-режиме она задаёт
    локального пользователя для pytest/Playwright-харнесса и отладки.
    """
    import os

    from app.core.config import get_settings

    raw = os.environ.get("JUPYTERHUB_USER") or get_settings().jupyterhub_user
    if not raw or raw == "unknown_user":
        return None
    digits = "".join(ch for ch in raw.split("_")[0] if ch.isdigit())
    return digits or None
