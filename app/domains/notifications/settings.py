"""Настройки домена центра уведомлений (env-префикс NOTIFICATIONS__)."""

from pathlib import Path
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class EmailSettings(BaseSettings):
    """Параметры SMTP для отправки email (env-префикс NOTIFICATIONS__EMAIL__*)."""

    model_config = SettingsConfigDict(
        env_prefix="NOTIFICATIONS__EMAIL__",
        env_file=str(Path(__file__).resolve().parent.parent.parent.parent / ".env"),
        extra="ignore",
    )

    # Включить отправку email.
    enabled: bool = True
    # SMTP сервер.
    smtp_host: str = Field(default="smtp.company.com")
    # SMTP порт (обычно 587 для TLS или 465 для SSL).
    smtp_port: int = Field(default=587, ge=1, le=65535)
    # Email отправителя (логин SMTP).
    smtp_user: str = Field(default="")
    # Секретный пароль SMTP (пароль запрашивается при инициализации).
    smtp_password: str = Field(default="")
    # Email по умолчанию для поля From.
    default_from: str = Field(default="noreply@company.com")


class NotificationsSettings(BaseSettings):
    """Параметры центра уведомлений, настраиваемые через NOTIFICATIONS__* в .env."""

    model_config = SettingsConfigDict(
        env_prefix="NOTIFICATIONS__",
        env_file=str(Path(__file__).resolve().parent.parent.parent.parent / ".env"),
        extra="ignore",
    )

    # Лимит уведомлений в списке по умолчанию (GET /api/v1/notifications?limit=).
    list_limit: int = 50
    # Срок хранения уведомлений в днях (для опциональной фоновой очистки;
    # в первой версии параметр заведён, но cleanup не реализован).
    retention_days: int = 90
    # Частота опроса персистентных уведомлений фронтом (секунды). Отдаётся
    # фронту через GET /config; «триггерные» (живые источники, push) на этот
    # параметр не влияют — он только про периодический опрос по таймеру.
    poll_interval_seconds: int = 30
    # Email settings - читается из переменных окружения NOTIFICATIONS__EMAIL__*
    email: EmailSettings = Field(default_factory=lambda: EmailSettings())
