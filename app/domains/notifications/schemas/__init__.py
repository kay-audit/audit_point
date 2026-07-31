"""Pydantic-схемы домена центра уведомлений."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.domains.notifications.schemas.email import (
    EmailSendRequest,
    EmailSendResponse,
    EmailTemplate,
    EmailTemplateCreate,
    EmailTemplateUpdate,
)

__all__ = [
    "NotificationOut",
    "NotificationCreate",
    "InternalNotificationCreate",
    "UnreadCount",
    "NotificationsConfigResponse",
    "EmailSendRequest",
    "EmailSendResponse",
    "EmailTemplate",
    "EmailTemplateCreate",
    "EmailTemplateUpdate",
]


class NotificationOut(BaseModel):
    """Уведомление в ответе списка (GET /api/v1/notifications)."""

    id: str
    source: str
    severity: str
    title: str
    body: str | None = None
    link: str | None = None
    element_ref: str | None = None
    created_at: datetime
    is_read: bool


class NotificationCreate(BaseModel):
    """Тело запроса на создание уведомления (POST /api/v1/notifications).

    ``recipient_user_id=None`` → broadcast всем. ``created_by`` проставляется
    эндпоинтом из текущего username, в теле не принимается.

    Длины полей соответствуют ширине колонок схемы — переполнение отклоняется
    на входе (422), а не падает StringDataRightTruncationError (500). severity —
    Literal под тот же набор, что и CHECK check_notifications_severity.
    """

    recipient_user_id: str | None = Field(default=None, max_length=50)
    source: str = Field(max_length=100)
    severity: Literal["info", "success", "warning", "error"] = "info"
    title: str = Field(max_length=300)
    body: str | None = None
    link: str | None = Field(default=None, max_length=1000)
    element_ref: str | None = Field(default=None, max_length=200)


class InternalNotificationCreate(BaseModel):
    """Тело внутреннего (service-to-service) запроса на уведомление.

    Для вызовов из sidecar-процессов в том же per-user контейнере (SQLAgent).
    ``source`` / ``recipient_user_id`` / ``created_by`` в теле НЕ принимаются —
    их форсит эндпоинт (адресат = текущий пользователь, источник фиксирован).
    """

    severity: Literal["info", "success", "warning", "error"] = "info"
    title: str = Field(max_length=300)
    body: str | None = None
    link: str | None = Field(default=None, max_length=1000)


class UnreadCount(BaseModel):
    """Сводка непрочитанных уведомлений (GET /api/v1/notifications/unread-count).

    ``severity`` — максимальная критичность среди непрочитанных видимых
    уведомлений (для окраски бейджа), или None, если непрочитанных нет.
    """

    count: int = Field(ge=0)
    severity: Literal["error", "warning", "info"] | None = None


class NotificationsConfigResponse(BaseModel):
    """Настройки центра уведомлений для фронтенда (GET /api/v1/notifications/config).

    ``pollIntervalSeconds`` — частота периодического опроса персистентных
    уведомлений. camelCase под фронт (как у acts /config/lock).
    """

    pollIntervalSeconds: int
    emailEnabled: bool
