"""Единый ядерный хелпер эмиссии персистентных уведомлений.

Общая точка для продьюсеров (домены acts, chat): мягко разрешает фабрику
``notifications.push`` через реестр доменов и зовёт ``svc.push`` с
``created_by="system"``. Вынесён в core, чтобы продьюсеры не дублировали
блок резолва фабрики + try/except.

Контракт:
- эмитим ТОЛЬКО после успеха основной операции (вызывающий код решает когда);
- любой сбой или отсутствие фабрики НЕ должен ломать основную операцию —
  вся эмиссия обёрнута в try/except с логированием (``warning``);
- ``has_factory``-guard: если домен notifications не зарегистрирован,
  эмиссия молча пропускается (важно для юнит-тестов продьюсеров, где
  notifications не поднимается — никакой регрессии).

``body`` пробрасывается: продьюсеры (например, статус акта #8) передают в нём
конкретику — список замечаний — которую центр уведомлений показывает в теле.
"""

import logging

logger = logging.getLogger("audit_workstation.core.notifications_emit")


async def push_notification(
    *,
    source: str,
    title: str,
    body: str | None = None,
    severity: str = "info",
    link: str | None = None,
    recipient_user_id: str | None = None,
) -> None:
    """Мягко эмитит уведомление через фабрику ``notifications.push``.

    Импорт ``has_factory``/``get_factory`` — локальный (внутри функции), чтобы
    не плодить import-циклы и чтобы тесты могли патчить реестр фабрик.

    Args:
        source: домен-источник события ('acts'/'chat').
        title: заголовок уведомления (пользовательский текст).
        body: подробности (многострочный текст), напр. список замечаний акта.
        severity: важность ('info'/'success'/'warning'/'error').
        link: proxy-safe относительный путь (например ``/constructor?act_id=42``);
            ``None`` — переход из уведомления не предусмотрен.
        recipient_user_id: адресат; ``None`` — broadcast всем (использовать
            осознанно).
    """
    # Локальный импорт: не создаёт жёсткой зависимости на module-level и
    # позволяет тестам патчить реестр фабрик.
    from app.core.domain_registry import get_factory, has_factory

    try:
        if not has_factory("notifications.push"):
            # Домен notifications не зарегистрирован — тихо пропускаем.
            return
        factory = get_factory("notifications.push")
        svc = factory()
        await svc.push(
            source=source,
            title=title,
            body=body,
            severity=severity,
            link=link,
            recipient_user_id=recipient_user_id,
            created_by="system",
        )
    except Exception:
        # Сбой уведомления НЕ должен ломать основную операцию.
        logger.warning(
            "Не удалось эмитировать уведомление (source=%s, получатель=%s)",
            source,
            recipient_user_id,
            exc_info=True,
        )
