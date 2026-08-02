"""Сервисы домена центра уведомлений."""

from app.domains.notifications.services.email_service import (
    init_email_service,
    send_email,
    EmailService,
)
from app.domains.notifications.services.notification_service import (
    NotificationService,
)

__all__ = [
    "NotificationService",
    "EmailService",
    "init_email_service",
    "send_email",
]
