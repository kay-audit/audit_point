"""Настройки auth-домена.

Параметры читаются из .env через префикс AUTH__* .
Регистрируются в глобальном settings_registry как домен 'auth'.
"""
from pydantic import BaseModel, Field


class AuthSettings(BaseModel):
    """Конфигурация модуля авторизации."""

    session_cookie_name: str = Field(default="aw_session")
    session_ttl_hours: int = Field(default=24, ge=1, le=24 * 30)
    session_cookie_secure: bool = Field(
        default=False,
        description="True = ставить cookie с флагом Secure (только за HTTPS).",
    )
    fernet_key: str = Field(
        default="",
        description=(
            "Base64-Fernet-ключ для шифрования пароля в БД "
            "(только владелец может расшифровать через свой профиль). "
            "Если пусто — шифрование отключено, поле password_recovery остаётся NULL."
        ),
    )
    login_max_attempts_per_minute: int = Field(default=10, ge=1)
    avatar_max_size_bytes: int = Field(default=2 * 1024 * 1024, ge=1024)
    avatar_allowed_mime: list[str] = Field(
        default_factory=lambda: ["image/png", "image/jpeg", "image/webp"]
    )
