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
    callable без аргументов, возвращающий async-генератор, который отдаёт
    ``EmailService()``. Соединение с БД не берётся: сервис работает только с
    SMTP, а отправка письма занимает до 30 секунд — держать всё это время
    соединение из пула нельзя. Форма генератора сохранена ради единообразия
    с ``notifications.push``: продьюсеры используют обе через ``async for``.

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
        """Создаёт EmailService в виде async-генератора.

        Соединения с БД не удерживает (сервису оно не нужно), форма генератора
        совпадает с ``notifications.push``: ``async for svc in factory():``.
        """
        async def _gen():
            yield EmailService()
        return _gen()

    register_factory("notifications.email", _email_factory)


def register_email_startup_hook() -> None:
    """Регистрирует startup-hook инициализации SMTP-клиента email-отправки.

    Пароль только из env; интерактивных запросов нет — сервер стартует headless.
    Вызывается на этапе сборки DomainDescriptor (``_build_domain``) — реестр
    hooks сбрасывается вместе с domain_registry, дубликатов не возникает.
    """
    import logging

    from app.core.domain_registry import register_startup_hook

    logger = logging.getLogger("audit_workstation.domains.notifications.lifecycle")

    async def _init_email(app) -> None:
        from app.core.settings_registry import get as get_domain_settings
        from app.domains.notifications.services.email_service import init_email_service
        from app.domains.notifications.settings import NotificationsSettings

        email_cfg = get_domain_settings("notifications", NotificationsSettings).email
        if not email_cfg.enabled:
            return
        if not email_cfg.smtp_password:
            logger.warning(
                "NOTIFICATIONS__EMAIL__ENABLED=true, но SMTP-пароль не задан — "
                "email-отправка выключена (ОТП-коды будут только в логе)"
            )
            return
        init_email_service(
            smtp_host=email_cfg.smtp_host,
            smtp_port=email_cfg.smtp_port,
            smtp_user=email_cfg.smtp_user,
            smtp_password=email_cfg.smtp_password,
            default_from=email_cfg.default_from,
        )
        logger.debug("Email-сервис инициализирован")

    register_startup_hook("notifications.email_init", _init_email)
