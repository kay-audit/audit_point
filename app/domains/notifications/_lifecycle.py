"""Жизненный цикл домена центра уведомлений."""

import logging

logger = logging.getLogger("audit_workstation.domains.notifications.lifecycle")


def register_factories() -> None:
    """
    Регистрирует фабрики, экспортируемые notifications-доменом для других доменов.

    Контракт фабрики ``notifications.push`` (зеркало ``admin.user_directory``):
    callable без аргументов, возвращающий async-генератор, который оборачивает
    ``get_db()`` и отдаёт ``NotificationService(conn)``. Продьюсеры (acts, chat)
    используют её мягко через ``has_factory``/``get_factory``:

        if has_factory("notifications.push"):
            factory = get_factory("notifications.push")
            async for svc in factory():
                await svc.push(source="acts", title=..., recipient_user_id=...)

    Контракт фабрики ``notifications.email``:
    callable без аргументов, возвращающий async-генератор, который оборачивает
    ``get_db()`` и отдаёт ``EmailService(conn)``. Продьюсеры используют её для
    отправки email-уведомлений.

    Вызывается на этапе сборки DomainDescriptor (``_build_domain``) — это
    гарантирует, что фабрика доступна до старта lifespan'а продьюсеров.
    Идемпотентна: повторный вызов перезаписывает фабрику.
    """
    from app.core.domain_registry import register_factory
    from app.db.connection import get_db
    from app.domains.notifications.services.notification_service import (
        NotificationService,
    )
    from app.domains.notifications.services.email_service import EmailService

    def _push_factory():
        """Создаёт NotificationService, оборачивая get_db() в async-генератор.

        Возвращает async-генератор — продьюсеры используют его через
        ``async for svc in factory():`` (соединение освобождается по выходу).
        """
        async def _gen():
            async with get_db() as conn:
                yield NotificationService(conn)
        return _gen()

    register_factory("notifications.push", _push_factory)

    def _email_factory():
        """Создаёт EmailService, оборачивая get_db() в async-генератор.

        Возвращает async-генератор — продьюсеры используют его через
        ``async for svc in factory():`` (соединение освобождается по выходу).
        """
        async def _gen():
            async with get_db() as conn:
                yield EmailService(conn)
        return _gen()

    register_factory("notifications.email", _email_factory)
