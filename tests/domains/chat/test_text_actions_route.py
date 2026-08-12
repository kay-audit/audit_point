"""Тесты выбора маршрута для text-actions (``llm_route.resolve_target``).

Redis — fakeredis через autouse-фикстуру ``fake_redis`` (tests/conftest.py):
роль воркера играет прямая запись heartbeat-ключа.

Смысл модуля — снять расхождение между чатом и text-actions: до него корректор
и формализатор всегда били в primary-профиль и отказывали там, где чат спокойно
работал через fallback-маршрут.
"""
import json

from app.domains.chat.services.redis_bridge_adapter import RedisBridgeClient
from app.domains.chat.services.text_actions.llm_route import resolve_target
from app.domains.chat.settings import ChatDomainSettings

ALIVE_KEY = "llm:bridge:worker:alive"


async def put_heartbeat(fake_redis, targets: list[str]) -> None:
    await fake_redis.set(
        ALIVE_KEY,
        json.dumps({"worker_id": "test", "targets": targets}),
        ex=45,
    )


def bridge_settings(
    primary: str = "redis-bridge,openai",
    fallback: str | None = "redis-bridge,gigachat",
    **kw,
) -> ChatDomainSettings:
    return ChatDomainSettings(
        profile=primary, fallback_profile=fallback, model="primary-model", **kw,
    )


class TestRouteSelection:
    async def test_primary_used_when_worker_serves_it(self, fake_redis):
        await put_heartbeat(fake_redis, ["openai", "gigachat"])

        client, model = await resolve_target(bridge_settings())

        assert isinstance(client, RedisBridgeClient)
        assert client._target == "openai"
        assert model == "primary-model"

    async def test_falls_through_to_fallback_when_primary_absent(self, fake_redis):
        """Воркер отдаёт только gigachat, primary — openai: идём на fallback.

        Ровно тот случай, в котором чат работал, а формализатор отдавал 503.
        """
        await put_heartbeat(fake_redis, ["gigachat"])

        client, _model = await resolve_target(bridge_settings())

        assert client._target == "gigachat"

    async def test_no_routes_returns_none(self, fake_redis):
        """Воркер не заявляет ни одной нужной цели → None, запрос не уходит."""
        await put_heartbeat(fake_redis, ["something-else"])

        assert await resolve_target(bridge_settings()) is None

    async def test_dead_worker_returns_none(self, fake_redis):
        """Heartbeat'а нет вовсе — маршрутов моста тоже нет."""
        assert await resolve_target(bridge_settings()) is None


class TestModelSelection:
    async def test_preferred_model_wins_on_primary(self, fake_redis):
        """Модель text-action перекрывает модель профиля на primary-маршруте."""
        await put_heartbeat(fake_redis, ["openai"])

        _client, model = await resolve_target(
            bridge_settings(), preferred_model="corrector-model",
        )

        assert model == "corrector-model"

    async def test_fallback_model_replaces_text_action_model(self, fake_redis):
        """На fallback-маршруте берётся fallback_model, а НЕ модель text-action.

        Имя модели text-action названо под основного провайдера; у другого
        провайдера её, скорее всего, просто нет — ушёл бы 404.
        """
        await put_heartbeat(fake_redis, ["gigachat"])
        settings = bridge_settings(fallback_model="giga-model")

        _client, model = await resolve_target(
            settings, preferred_model="corrector-model",
        )

        assert model == "giga-model"

    async def test_fallback_keeps_primary_model_when_not_configured(self, fake_redis):
        """fallback_model не задан → остаётся модель primary (как в чате)."""
        await put_heartbeat(fake_redis, ["gigachat"])

        _client, model = await resolve_target(
            bridge_settings(), preferred_model="corrector-model",
        )

        assert model == "corrector-model"
