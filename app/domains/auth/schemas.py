"""Pydantic-схемы auth-домена."""
from datetime import datetime

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    """Логин: username + password."""
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=255)


class LoginResponse(BaseModel):
    """Ответ при успешном логине."""
    username: str
    fullname: str
    job: str
    is_admin: bool
    avatar_available: bool


class ChangePasswordRequest(BaseModel):
    """Смена собственного пароля (требует знание текущего)."""
    old_password: str = Field(..., min_length=1, max_length=255)
    new_password: str = Field(..., min_length=1, max_length=255)


class AdminResetPasswordRequest(BaseModel):
    """Сброс пароля админом для другого пользователя (без знания старого)."""
    new_password: str | None = Field(
        default=None,
        description=(
            "Если пусто — сервер сгенерирует случайный 12-символьный пароль "
            "и вернёт его в ответе (показывается админу один раз)."
        ),
    )


class AdminResetPasswordResponse(BaseModel):
    """Ответ админу при сбросе пароля. new_password возвращается один раз."""
    username: str
    new_password: str


class MeResponse(BaseModel):
    """Информация о текущем авторизованном пользователе (для /me и попапа)."""
    authenticated: bool
    username: str | None = None
    fullname: str | None = None
    job: str | None = None
    is_admin: bool = False
    avatar_available: bool = False
    password_recoverable: bool = False


class UserInfoResponse(BaseModel):
    """Публичный профиль пользователя (ФИО, должность, логин, наличие аватарки)."""
    username: str
    fullname: str
    job: str
    is_admin: bool
    avatar_available: bool
