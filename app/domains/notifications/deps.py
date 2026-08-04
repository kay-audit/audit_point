"""DI-зависимости домена центра уведомлений.

Фабрика сервиса для FastAPI Depends. Сервис строится на исполнителе БД
(``get_executor()``): соединение берётся из пула на время одного SQL-вызова
или одной явной транзакции, а не на весь HTTP-запрос.
"""

from app.core.settings_registry import get as get_domain_settings
from app.db.executor import get_executor
from app.domains.notifications.services.notification_service import (
    NotificationService,
)
from app.domains.notifications.settings import NotificationsSettings


def get_notification_service() -> NotificationService:
    """Создаёт NotificationService на исполнителе БД (соединение на операцию)."""
    return NotificationService(get_executor())


def get_notifications_settings() -> NotificationsSettings:
    """Возвращает настройки домена уведомлений из реестра настроек."""
    from app.domains.notifications import DOMAIN_NAME
    return get_domain_settings(DOMAIN_NAME, NotificationsSettings)
