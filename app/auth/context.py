"""Контекст авторизации текущего запроса (username из JWT)."""

from contextvars import ContextVar

_request_username: ContextVar[str | None] = ContextVar("_request_username", default=None)


def set_request_username(username: str | None) -> None:
    """Сохраняет username аутентифицированного пользователя для текущего запроса."""
    _request_username.set(username)


def get_request_username() -> str | None:
    """Возвращает username из JWT-контекста или None."""
    return _request_username.get()
