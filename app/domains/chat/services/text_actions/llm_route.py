"""Выбор LLM-маршрута для text-actions (корректор, формализатор).

Зачем отдельно от чата. Чат ходит через ``call_llm_with_fallback``: тот строит
план маршрутов, пробует их по приоритету и при сбое провайдера переходит на
следующий. Text-actions — одиночные one-shot вызовы без агентного цикла, им
переход «на лету» не нужен, но выбор маршрута нужен ровно тот же: без него
корректор и формализатор всегда били бы в primary-профиль, даже когда воркер
моста его не обслуживает.

Расхождение было наблюдаемым: при ``CHAT__PROFILE=redis-bridge,openai`` и
воркере, поднятом только под gigachat, чат отвечал через fallback-маршрут, а
формализатор на том же стенде отдавал 503 «ИИ-сервис недоступен». Один и тот же
провайдер, разный ответ — потому что text-actions спрашивали не у плана, а у
настроек.

Здесь — только ВЫБОР цели (клиент + модель) по первому доступному маршруту.
Ретраи внутри маршрута остаются за ``retry_on_transient``, как и были.
"""
from __future__ import annotations

import logging
from typing import Any

from app.domains.chat.services.llm_client import (
    build_fallback_client,
    build_llm_client,
)
from app.domains.chat.services.llm_routing import plan_routes
from app.domains.chat.settings import ChatDomainSettings

logger = logging.getLogger("audit_workstation.chat.text_actions.route")


async def resolve_target(
    settings: ChatDomainSettings, *, preferred_model: str | None = None,
) -> tuple[Any, str] | None:
    """``(клиент, модель)`` первого доступного маршрута, либо ``None``.

    ``preferred_model`` — модель, заданная для конкретного text-action
    (``CHAT__TEXT_ACTIONS__CORRECTOR_MODEL`` и т.п.); пустое значение означает
    «брать модель профиля».

    Модель для fallback-маршрута выбирается так же, как в чате
    (``Orchestrator._adjust_kwargs_for_fallback``): если задан
    ``CHAT__FALLBACK_MODEL`` — берётся он, иначе остаётся модель primary.
    Модель text-action на fallback-маршрут НЕ переносится: она названа под
    основного провайдера, и у другого её, скорее всего, просто нет.

    ``None`` возвращается, когда доступных маршрутов не осталось — решение,
    какой ошибкой это показать пользователю, принимает вызывающий сервис
    (у корректора и формализатора разные тексты).
    """
    primary_model = preferred_model or settings.model
    plan = await plan_routes(settings)

    for route in plan.routes:
        if route.is_fallback:
            client = build_fallback_client(settings)
            model = settings.fallback_model or primary_model
        else:
            client = build_llm_client(settings)
            model = primary_model
        if client is None:
            # Маршрут прошёл планирование, но клиент не собрался — не фатально,
            # пока есть следующий (та же логика, что в llm_call).
            logger.warning(
                "text-action: клиент маршрута %s не создан, пропускаем",
                route.describe(),
            )
            continue
        if route.is_fallback:
            logger.info(
                "text-action идёт по fallback-маршруту %s: primary недоступен",
                route.describe(),
            )
        return client, model

    logger.error(
        "text-action: ни один LLM-маршрут не доступен, запрос не отправлен. "
        "Причины: %s", plan.describe_skipped(),
    )
    return None
