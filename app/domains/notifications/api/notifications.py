"""Эндпоинты центра уведомлений.

Колокольчик общий для всех страниц, поэтому эндпоинты защищены только
авторизацией (``Depends(get_username)``) — без доменного гейта на уровне
самого роутера.
"""

import logging

from fastapi import APIRouter, Depends, Query

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import require_admin
from app.domains.notifications.deps import (
    get_notification_service,
    get_notifications_settings,
)
from app.domains.notifications.schemas import (
    InternalNotificationCreate,
    NotificationCreate,
    NotificationOut,
    NotificationsConfigResponse,
    UnreadCount,
)
from app.domains.notifications.services.notification_service import (
    NotificationService,
)
from app.domains.notifications.settings import NotificationsSettings

logger = logging.getLogger("audit_workstation.domains.notifications.api")

router = APIRouter()

# Источник и ссылка уведомлений от встроенного SQL-агента (sidecar).
# Ссылкой владеет AW: для обычных уведомлений sidecar НЕ присылает link —
# подставляется _SQLAGENT_DEFAULT_LINK (единственный источник строки `/sqlagent`).
# Поле link в запросе оставлено опциональным override только под будущий
# deep-link на конкретную job (в этом случае URL строит AW).
_SQLAGENT_SOURCE = "sqlagent"
_SQLAGENT_DEFAULT_LINK = "/sqlagent"


@router.get("", response_model=list[NotificationOut], summary="Список уведомлений")
async def list_notifications(
    limit: int | None = Query(None, ge=1, le=200),
    username: str = Depends(get_username),
    service: NotificationService = Depends(get_notification_service),
    settings: NotificationsSettings = Depends(get_notifications_settings),
):
    """Возвращает видимые пользователю уведомления (адресные + broadcast).

    Без параметра ``limit`` берётся ``NOTIFICATIONS__LIST_LIMIT`` (с верхней
    границей 200). Скрытые исключены, сортировка по дате создания DESC.
    """
    effective_limit = limit if limit is not None else min(settings.list_limit, 200)
    return await service.list_for_user(username, limit=effective_limit)


@router.get(
    "/unread-count",
    response_model=UnreadCount,
    summary="Число непрочитанных",
)
async def get_unread_count(
    username: str = Depends(get_username),
    service: NotificationService = Depends(get_notification_service),
):
    """Число непрочитанных видимых уведомлений и их максимальная критичность.

    ``severity`` (для окраски бейджа) = максимальная критичность среди
    непрочитанных видимых уведомлений, или None, если непрочитанных нет.
    """
    summary = await service.unread_summary(username)
    return UnreadCount(count=summary["count"], severity=summary["severity"])


@router.get(
    "/config",
    response_model=NotificationsConfigResponse,
    summary="Настройки центра для фронтенда",
)
async def get_config(
    _username: str = Depends(get_username),
    settings: NotificationsSettings = Depends(get_notifications_settings),
):
    """Отдаёт фронту настройки центра уведомлений (частота опроса по таймеру)."""
    return NotificationsConfigResponse(
        pollIntervalSeconds=settings.poll_interval_seconds,
        emailEnabled=settings.email.enabled,
    )


@router.post("/{notification_id}/read", summary="Пометить прочитанным")
async def mark_read(
    notification_id: str,
    username: str = Depends(get_username),
    service: NotificationService = Depends(get_notification_service),
):
    """Помечает уведомление прочитанным для текущего пользователя."""
    await service.mark_read(notification_id, username)
    return {"ok": True}


@router.post("/{notification_id}/unread", summary="Вернуть в непрочитанное")
async def mark_unread(
    notification_id: str,
    username: str = Depends(get_username),
    service: NotificationService = Depends(get_notification_service),
):
    """Возвращает уведомление в непрочитанное для текущего пользователя."""
    await service.mark_unread(notification_id, username)
    return {"ok": True}


@router.post("/read-all", summary="Пометить все прочитанными")
async def mark_all_read(
    username: str = Depends(get_username),
    service: NotificationService = Depends(get_notification_service),
):
    """Помечает все видимые уведомления пользователя прочитанными."""
    await service.mark_all_read(username)
    return {"ok": True}


@router.post("/{notification_id}/dismiss", summary="Скрыть уведомление")
async def dismiss(
    notification_id: str,
    username: str = Depends(get_username),
    service: NotificationService = Depends(get_notification_service),
):
    """Скрывает уведомление для текущего пользователя."""
    await service.dismiss(notification_id, username)
    return {"ok": True}


@router.post("/internal", summary="Создать уведомление из sidecar-процесса")
async def create_internal_notification(
    payload: InternalNotificationCreate,
    username: str = Depends(get_username),
    service: NotificationService = Depends(get_notification_service),
):
    """Создаёт уведомление от встроенного агента в том же контейнере.

    В отличие от ``POST ""`` (admin-only), доступен любому авторизованному
    пользователю, но жёстко адресует уведомление ему самому
    (``recipient_user_id = username``) и фиксирует ``source``. Безопасно:
    эндпоинт достижим только изнутри per-user контейнера (граница изоляции),
    адресата и источник подделать нельзя.
    """
    notification_id = await service.push(
        source=_SQLAGENT_SOURCE,
        title=payload.title,
        severity=payload.severity,
        body=payload.body,
        link=payload.link or _SQLAGENT_DEFAULT_LINK,
        recipient_user_id=username,
        created_by=_SQLAGENT_SOURCE,
    )
    return {"id": notification_id}


@router.post(
    "",
    summary="Создать уведомление",
    dependencies=[Depends(require_admin())],
)
async def create_notification(
    payload: NotificationCreate,
    username: str = Depends(get_username),
    service: NotificationService = Depends(get_notification_service),
):
    """Создаёт уведомление. ``created_by`` = текущий username.

    ``recipient_user_id=None`` → broadcast всем. Создание доступно только
    администратору (require_admin); остальные эндпоинты — общий колокольчик.
    """
    notification_id = await service.push(
        source=payload.source,
        title=payload.title,
        severity=payload.severity,
        body=payload.body,
        link=payload.link,
        element_ref=payload.element_ref,
        recipient_user_id=payload.recipient_user_id,
        created_by=username,
    )
    return {"id": notification_id}
