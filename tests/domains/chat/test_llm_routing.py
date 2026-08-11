"""Тесты планировщика маршрутов LLM (``llm_routing.plan_routes``).

Redis — fakeredis через autouse-фикстуру ``fake_redis`` (tests/conftest.py):
роль воркера играет прямая запись heartbeat-ключа.

Проверяется главное свойство: в план попадают только маршруты, которые
реально существуют, в порядке приоритета — и ничего сверх того.
"""
import json

import pytest

from app.domains.chat.services.llm_routing import FALLBACK, PRIMARY, plan_routes
from app.domains.chat.settings import ChatDomainSettings

ALIVE_KEY = "llm:bridge:worker:alive"


async def put_heartbeat(
    fake_redis, targets: list[str], health: dict | None = None,
) -> None:
    payload = {"worker_id": "test", "targets": targets}
    if health is not None:
        payload["target_health"] = health
    await fake_redis.set(ALIVE_KEY, json.dumps(payload), ex=45)


def bridge_settings(
    primary: str = "redis-bridge,gigachat",
    fallback: str | None = "redis-bridge,openai",
) -> ChatDomainSettings:
    """Обе площадки через мост — ПРОМ-конфигурация."""
    return ChatDomainSettings(profile=primary, fallback_profile=fallback)


def kinds(plan) -> list[str]:
    return [route.kind for route in plan.routes]


def profiles(plan) -> list[str]:
    return [route.profile for route in plan.routes]


class TestBridgeRoutes:
    async def test_only_declared_target_gets_into_plan(self, fake_redis):
        """Воркер поднят только под gigachat → fallback на openai в план
        не попадает: ровно инцидент 11.08.2026, где эта ветка гарантированно
        падала с «цель 'openai' недоступна»."""
        await put_heartbeat(fake_redis, ["gigachat"])
        plan = await plan_routes(bridge_settings())

        assert profiles(plan) == ["redis-bridge,gigachat"]
        assert kinds(plan) == [PRIMARY]
        assert len(plan.skipped) == 1
        assert "openai" in plan.skipped[0].reason

    async def test_fallback_used_when_only_it_is_available(self, fake_redis):
        """Primary — openai-цель, воркер заявляет только gigachat: идём на
        fallback, хотя primary даже не пробовали."""
        await put_heartbeat(fake_redis, ["gigachat"])
        plan = await plan_routes(bridge_settings(
            primary="redis-bridge,openai", fallback="redis-bridge,gigachat",
        ))

        assert profiles(plan) == ["redis-bridge,gigachat"]
        assert kinds(plan) == [FALLBACK]

    async def test_both_targets_declared_keep_priority(self, fake_redis):
        await put_heartbeat(fake_redis, ["gigachat", "openai"])
        plan = await plan_routes(bridge_settings())

        assert kinds(plan) == [PRIMARY, FALLBACK]
        assert plan.skipped == ()

    async def test_no_heartbeat_gives_empty_plan_with_reasons(self, fake_redis):
        """Воркер не запущен → пробовать нечего; причина по каждому маршруту
        уходит в план, чтобы llm_call написал её в лог."""
        plan = await plan_routes(bridge_settings())

        assert plan.routes == ()
        assert len(plan.skipped) == 2
        assert all("heartbeat" in s.reason for s in plan.skipped)
        assert "heartbeat" in plan.describe_skipped()

    async def test_broken_heartbeat_json_is_not_a_crash(self, fake_redis):
        """Кривой heartbeat — не AttributeError мимо планировщика, а пустой
        список целей (значит, маршрутов нет)."""
        await fake_redis.set(ALIVE_KEY, "не json", ex=45)
        plan = await plan_routes(bridge_settings())

        assert plan.routes == ()

    async def test_unhealthy_target_is_demoted_not_dropped(self, fake_redis):
        """target_health=false опускает маршрут в конец, но не выбрасывает:
        ложноотрицательный health-check воркера не должен лишать
        пользователя единственного провайдера."""
        await put_heartbeat(
            fake_redis, ["gigachat", "openai"],
            health={"gigachat": False, "openai": True},
        )
        plan = await plan_routes(bridge_settings())

        assert kinds(plan) == [FALLBACK, PRIMARY]
        assert plan.routes[0].healthy is True
        assert plan.routes[1].healthy is False

    async def test_single_unhealthy_target_still_used(self, fake_redis):
        await put_heartbeat(
            fake_redis, ["gigachat"], health={"gigachat": False},
        )
        plan = await plan_routes(bridge_settings(fallback=None))

        assert profiles(plan) == ["redis-bridge,gigachat"]


class TestHttpRoutes:
    async def test_http_route_without_credentials_is_skipped(self, fake_redis):
        plan = await plan_routes(ChatDomainSettings(profile="openai"))

        assert plan.routes == ()
        assert "CHAT__API_BASE" in plan.skipped[0].reason
        assert "CHAT__API_KEY" in plan.skipped[0].reason

    async def test_http_route_with_credentials_is_available(self, fake_redis):
        plan = await plan_routes(ChatDomainSettings(
            profile="openai", api_base="http://x/v1", api_key="k",
        ))

        assert profiles(plan) == ["openai"]

    async def test_http_fallback_needs_its_own_credentials(self, fake_redis):
        """Для HTTP-fallback обязательны FALLBACK_API_BASE/KEY — иначе это
        не маршрут, а строка в конфиге."""
        plan = await plan_routes(ChatDomainSettings(
            profile="openai", api_base="http://x/v1", api_key="k",
            fallback_profile="gigachat",
        ))

        assert kinds(plan) == [PRIMARY]
        assert "CHAT__FALLBACK_API_BASE" in plan.skipped[0].reason

    async def test_mixed_transports_are_planned_together(self, fake_redis):
        """Primary HTTP + fallback через мост: heartbeat читается только ради
        второго маршрута."""
        await put_heartbeat(fake_redis, ["openai"])
        plan = await plan_routes(ChatDomainSettings(
            profile="gigachat", api_base="http://gc/v1", api_key="k",
            fallback_profile="redis-bridge,openai",
        ))

        assert profiles(plan) == ["gigachat", "redis-bridge,openai"]


class TestBreakerInteraction:
    async def test_open_breaker_demotes_primary(self, fake_redis):
        await put_heartbeat(fake_redis, ["gigachat", "openai"])
        plan = await plan_routes(bridge_settings(), breaker_open=True)

        assert kinds(plan) == [FALLBACK, PRIMARY]

    async def test_open_breaker_keeps_lone_primary(self, fake_redis):
        """Переставлять нечего: primary остаётся единственным маршрутом,
        а не превращается в пустой план."""
        await put_heartbeat(fake_redis, ["gigachat"])
        plan = await plan_routes(bridge_settings(), breaker_open=True)

        assert kinds(plan) == [PRIMARY]


@pytest.mark.parametrize("fallback", [None, ""])
class TestFallbackDisabled:
    async def test_no_fallback_configured_plans_primary_only(
        self, fake_redis, fallback,
    ):
        await put_heartbeat(fake_redis, ["gigachat", "openai"])
        plan = await plan_routes(bridge_settings(fallback=fallback))

        assert kinds(plan) == [PRIMARY]
        assert plan.skipped == ()

    async def test_no_fallback_and_dead_primary_gives_empty_plan(
        self, fake_redis, fallback,
    ):
        """Fallback не задан, primary недоступен → сразу ошибка пользователю,
        без попыток и ретраев."""
        plan = await plan_routes(bridge_settings(fallback=fallback))

        assert plan.routes == ()
        assert len(plan.skipped) == 1
