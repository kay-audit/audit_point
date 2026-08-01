"""Сервисы домена центра уведомлений."""

from app.domains.notifications.services.email_service import (
    init_email_service,
    get_mail_client,
    send_email,
    send_email_to_user,
    EmailService,
)
from app.domains.notifications.services.notification_service import (
    NotificationService,
)

__all__ = [
    "NotificationService",
    "EmailService",
    "init_email_service",
    "get_mail_client",
    "send_email",
    "send_email_to_user",
]
