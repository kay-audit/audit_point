"""Планирование маршрутов LLM: работаем только с реально доступными.

Раньше порядок был жёстким: primary → (при сбое) fallback. Маршрут пробовался
независимо от того, существует ли он вообще. На ПРОМе это давало бессмысленную
работу: ``CHAT__FALLBACK_PROFILE=redis-bridge,openai`` при воркере, поднятом
только под GigaChat, гарантированно падал с «цель 'openai' недоступна» —
но лишь ПОСЛЕ того, как primary исчерпает ретраи и разомкнёт breaker.

Здесь маршруты сначала спрашиваются на доступность, и план строится только
из существующих, в порядке приоритета:

- **primary** (``CHAT__PROFILE``) — первый;
- **fallback** (``CHAT__FALLBACK_PROFILE``) — второй, если задан;
- недоступный маршрут в план не попадает вовсе (и не тратит ни ретраев,
  ни счётчика circuit breaker'а);
- если доступен только fallback — идём на него сразу, не изображая сбой
  primary'я, которого физически нет;
- если не осталось ни одного — запрос не отправляется: пользователь получает
  внятную ошибку, а в лог уходит список маршрутов с причиной отказа каждого.

Что считается доступностью:

- **HTTP-маршрут** (``gigachat`` / ``openai``) — заданы api_base и api_key.
  Проверить живость сервера здесь нельзя, не заплатив запросом, поэтому
  «доступен» = «сконфигурирован»; реальный сбой по-прежнему ловит retry
  и circuit breaker.
- **redis-bridge-маршрут** — воркер жив (есть heartbeat) и заявил цель в
  ``targets``. Один ``GET`` heartbeat'а на планирование обслуживает оба
  redis-маршрута сразу.

``target_health`` из heartbeat'а (воркер сам пингует свои бэкенды) НЕ
исключает маршрут, а опускает его в конец плана: ложноотрицательный
health-check воркера не должен лишать пользователя единственного живого
провайдера — это то же решение, что и в ``_ensure_worker_available``
(``require_healthy`` не используется на пользовательском пути).

Разомкнутый circuit breaker обрабатывается отдельно (``without_primary``
поверх готового плана, см. llm_call): это не вопрос доступности маршрута,
и решает его тот, кто держит breaker.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.domains.chat.settings import ChatDomainSettings, parse_route

# Логирует результат планирования вызывающий (llm_call): только он знает,
# изменился ли план с прошлого раза, и умеет не писать один и тот же warning
# на каждый раунд agent loop.

PRIMARY = "primary"
FALLBACK = "fallback"


@dataclass(frozen=True)
class Route:
    """Один маршрут LLM в плане вызова."""

    kind: str            # PRIMARY | FALLBACK
    profile: str         # "openai" | "gigachat" | "redis-bridge,<цель>"
    transport: str       # "http" | "redis"
    wire_format: str     # "openai" | "gigachat"
    healthy: bool = True  # False → воркер пометил цель нездоровой

    @property
    def is_fallback(self) -> bool:
        return self.kind == FALLBACK

    def describe(self) -> str:
        """Человекочитаемое имя для логов: 'fallback redis-bridge,openai'."""
        return f"{self.kind} {self.profile}"


@dataclass(frozen=True)
class SkippedRoute:
    """Маршрут, не попавший в план, и причина."""

    route: Route
    reason: str


@dataclass(frozen=True)
class RoutePlan:
    """Итог планирования: что пробуем и что пропустили (и почему)."""

    routes: tuple[Route, ...]
    skipped: tuple[SkippedRoute, ...]

    def describe_skipped(self) -> str:
        """'primary redis-bridge,openai — воркер заявляет ['gigachat']; ...'."""
        return "; ".join(
            f"{item.route.describe()} — {item.reason}" for item in self.skipped
        ) or "нет"


def _candidate_routes(settings: ChatDomainSettings) -> list[Route]:
    """Маршруты-кандидаты в порядке приоритета: primary, затем fallback."""
    transport, wire_format = parse_route(settings.profile)
    routes = [Route(
        kind=PRIMARY,
        profile=settings.profile,
        transport=transport,
        wire_format=wire_format,
    )]
    if settings.fallback_profile:
        fb_transport, fb_wire = parse_route(settings.fallback_profile)
        routes.append(Route(
            kind=FALLBACK,
            profile=settings.fallback_profile,
            transport=fb_transport,
            wire_format=fb_wire,
        ))
    return routes


def _http_route_problem(
    route: Route, settings: ChatDomainSettings,
) -> str | None:
    """Причина, по которой HTTP-маршрут не сконфигурирован, либо None."""
    if route.is_fallback:
        api_base = settings.fallback_api_base
        api_key = settings.fallback_api_key
        base_var, key_var = "CHAT__FALLBACK_API_BASE", "CHAT__FALLBACK_API_KEY"
    else:
        api_base = settings.api_base
        api_key = settings.api_key
        base_var, key_var = "CHAT__API_BASE", "CHAT__API_KEY"
    missing = []
    if not api_base:
        missing.append(base_var)
    if api_key is None or not api_key.get_secret_value():
        missing.append(key_var)
    if missing:
        return f"не заданы {', '.join(missing)}"
    return None


def can_skip_primary(plan: RoutePlan) -> bool:
    """True, если primary есть в плане И есть чем его заменить.

    Условие для похода в circuit breaker: спрашивать ``is_open()``, когда
    ответ ничего не изменит, нельзя — этот вызов не чистый, он сам переводит
    open → half_open по таймеру. Лишний вызов оставил бы breaker в half_open
    без пробы, и следующий же сбой primary кинул бы его сразу в open,
    минуя ``failure_threshold``.
    """
    kinds = {route.kind for route in plan.routes}
    return PRIMARY in kinds and len(plan.routes) > 1


def without_primary(plan: RoutePlan, reason: str) -> RoutePlan:
    """План без primary-маршрута; убранный уходит в skipped с причиной.

    Используется при разомкнутом breaker'е: primary именно ИСКЛЮЧАЕТСЯ, а не
    опускается в конец. Иначе после сбоя fallback'а каждый запрос дожигал бы
    полный retry-бюджет об заведомо лежащий primary (ради чего breaker и
    существует), а его ``record_failure`` в состоянии open заново
    проштамповывал бы ``_opened_at`` — при ``external_recovery=False``
    таймерное восстановление не наступило бы никогда.
    """
    kept = tuple(r for r in plan.routes if r.kind != PRIMARY)
    dropped = tuple(
        SkippedRoute(r, reason) for r in plan.routes if r.kind == PRIMARY
    )
    return RoutePlan(routes=kept, skipped=plan.skipped + dropped)


async def plan_routes(settings: ChatDomainSettings) -> RoutePlan:
    """Строит план вызова из реально доступных маршрутов.

    Redis-маршруты проверяются по одному чтению heartbeat'а на весь план.
    Состояние circuit breaker здесь не учитывается — см. ``without_primary``.
    """
    from app.domains.chat.services.redis_bridge_adapter import (
        target_is_healthy,
        try_read_worker_heartbeat,
        worker_targets,
    )

    candidates = _candidate_routes(settings)
    heartbeat: dict | None = None
    heartbeat_read = False

    available: list[Route] = []
    skipped: list[SkippedRoute] = []

    for route in candidates:
        if route.transport == "http":
            problem = _http_route_problem(route, settings)
            if problem:
                skipped.append(SkippedRoute(route, problem))
            else:
                available.append(route)
            continue

        # redis-bridge: heartbeat читаем один раз на планирование.
        if not heartbeat_read:
            heartbeat = await try_read_worker_heartbeat(
                settings.redis_bridge.key_prefix,
            )
            heartbeat_read = True
        if heartbeat is None:
            skipped.append(SkippedRoute(
                route, "воркер не отвечает (heartbeat отсутствует)",
            ))
            continue
        targets = worker_targets(heartbeat)
        if route.wire_format not in targets:
            skipped.append(SkippedRoute(
                route,
                f"воркер не заявляет цель {route.wire_format!r} "
                f"(доступны {targets!r})",
            ))
            continue
        available.append(Route(
            kind=route.kind,
            profile=route.profile,
            transport=route.transport,
            wire_format=route.wire_format,
            healthy=target_is_healthy(heartbeat, route.wire_format),
        ))

    # Нездоровые — в конец, приоритет внутри групп сохраняется (sort стабилен).
    ordered = sorted(available, key=lambda r: not r.healthy)
    return RoutePlan(routes=tuple(ordered), skipped=tuple(skipped))
