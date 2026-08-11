"""LLM-вызов по плану доступных маршрутов, с circuit-breaker и fallback.

Логика жила в ``Orchestrator._llm_call_with_fallback`` (~70 строк). Вынесена
сюда отдельной свободной async-функцией, принимающей ссылку на оркестратор:
все зависимости (circuit-breaker, retry, completions_create,
get_fallback_client, adjust_kwargs_for_fallback) — методы класса
``Orchestrator``, которые тесты могут патчить через ``patch.object`` / instance
assign. Pure-функция зовёт их через ``orch.``, поэтому существующие mock'и
продолжают работать.

Контракт вызова прежний:
    result = await call_llm_with_fallback(
        orch, client, force_non_streaming=False, **kwargs,
    )
Возвращает ``(result, fallback_used, active_client)``.

Что изменилось: порядок маршрутов больше не зашит «primary, потом fallback»,
а строится ``llm_routing.plan_routes`` из маршрутов, которые реально
существуют (см. docstring того модуля). Практические следствия:

- недоступный маршрут не отнимает ни ретраев, ни счётчика breaker'а —
  бессмысленный поход в цель, которой нет у воркера, не совершается вовсе;
- если доступен только fallback, вызов идёт сразу на него: это не
  «сбой primary», а нормальная работа по единственному живому маршруту;
- если не осталось ни одного маршрута — ChatLLMUnavailableError, причина
  по каждому маршруту в логе.

Счётчик circuit breaker ведёт ТОЛЬКО primary-маршрут: breaker существует,
чтобы не ходить в лежащий основной провайдер, и сбои fallback'а его
семантику размывали бы.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from app.domains.chat.exceptions import ChatLLMUnavailableError
from app.domains.chat.services.llm_routing import Route, plan_routes

if TYPE_CHECKING:
    from app.domains.chat.services.orchestrator import Orchestrator

logger = logging.getLogger("audit_workstation.domains.chat.llm_call")

_NO_ROUTES_MESSAGE = (
    "AI-ассистент недоступен: нет ни одного доступного LLM-провайдера. "
    "Сообщите администратору."
)


def _client_for(orch: "Orchestrator", route: Route, primary_client):
    """Клиент маршрута: primary — переданный, fallback — из настроек."""
    if route.is_fallback:
        return orch._get_fallback_client()
    return primary_client


def _kwargs_for(
    orch: "Orchestrator", route: Route, kwargs: dict, *,
    force_non_streaming: bool,
) -> dict:
    """kwargs под маршрут: для fallback — подмена модели и non-streaming."""
    if route.is_fallback:
        return orch._adjust_kwargs_for_fallback(
            kwargs, force_non_streaming=force_non_streaming,
        )
    return dict(kwargs)


async def call_llm_with_fallback(
    orch: "Orchestrator",
    client,
    *,
    force_non_streaming: bool = False,
    **kwargs,
) -> tuple[Any, bool, Any]:
    """Вызывает LLM по первому доступному маршруту, при сбое — по следующему.

    Возвращает кортеж ``(result, fallback_used, active_client)``, где
    ``active_client`` — клиент, через который реально прошёл вызов.

    Логика:
      1. Планируем маршруты (доступные, в порядке приоритета; при открытом
         breaker'е primary опускается в конец).
      2. Пустой план — ChatLLMUnavailableError, ни одного запроса не уходит.
      3. Идём по плану: provider-failure → следующий маршрут; клиентская
         ошибка (4xx/валидация) пробрасывается сразу — другой провайдер
         её не исправит.
      4. Успех/сбой primary-маршрута отражается в circuit breaker'е.

    ``force_non_streaming`` — если True и fallback=gigachat, перед вызовом
    fallback'а удаляется stream=True из kwargs.
    """
    breaker = orch._get_circuit_breaker()
    plan = await plan_routes(
        orch.settings, breaker_open=await breaker.is_open(),
    )

    if not plan.routes:
        logger.error(
            "LLM: ни один маршрут не доступен, запрос не отправлен. "
            "Причины: %s", plan.describe_skipped(),
        )
        raise ChatLLMUnavailableError(_NO_ROUTES_MESSAGE)

    if plan.skipped:
        logger.warning(
            "LLM маршруты: пробуем [%s]; пропущены: %s",
            ", ".join(r.describe() for r in plan.routes),
            plan.describe_skipped(),
        )

    last_exc: BaseException | None = None
    last_index = len(plan.routes) - 1

    for index, route in enumerate(plan.routes):
        route_client = _client_for(orch, route, client)
        if route_client is None:
            # Маршрут прошёл планирование, но клиент не собрался (например,
            # ключ пропал между проверкой и построением) — не фатально,
            # пока есть следующий.
            logger.warning(
                "LLM маршрут %s: клиент не создан, пропускаем",
                route.describe(),
            )
            continue

        route_kwargs = _kwargs_for(
            orch, route, kwargs, force_non_streaming=force_non_streaming,
        )
        try:
            result = await orch._completions_create(route_client, **route_kwargs)
        except Exception as exc:
            if not orch._is_provider_failure(exc):
                # Клиентская ошибка / NotFound / 4xx — другой маршрут не поможет.
                raise
            if not route.is_fallback:
                await breaker.record_failure(exc)
            last_exc = exc
            if index == last_index:
                raise
            logger.warning(
                "LLM маршрут %s упал (%s); переходим на следующий",
                route.describe(), type(exc).__name__,
            )
            continue

        if not route.is_fallback:
            await breaker.record_success()
        return result, route.is_fallback, route_client

    # Сюда попадаем, только если все маршруты отвалились на построении клиента.
    if last_exc is not None:
        raise last_exc
    logger.error(
        "LLM: ни один клиент маршрута не построен (маршруты: %s)",
        ", ".join(r.describe() for r in plan.routes),
    )
    raise ChatLLMUnavailableError(_NO_ROUTES_MESSAGE)
