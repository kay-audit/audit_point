"""Тесты единого ядерного хелпера эмиссии уведомлений ``push_notification``.

Хелпер ``app.core.notifications_emit.push_notification`` — общая точка для
продьюсеров (acts, chat): мягко разрешает фабрику ``notifications.push`` через
реестр доменов и зовёт ``svc.push`` с ``created_by="system"``. Любой сбой или
отсутствие фабрики проглатываются (основная операция не должна ломаться).

Кейсы:
- фабрика зарегистрирована → ``svc.push`` вызывается с верными
  source/severity/link/recipient_user_id/created_by;
- ``has_factory`` == False → no-op без исключения;
- ``svc.push`` бросает → проглочено (нет исключения наружу);
- ``factory()`` бросает при разворачивании → проглочено.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core import domain_registry
from app.core.notifications_emit import push_notification


# ── Autouse-сброс реестра фабрик ─────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_registries():
    """Сбрасывает реестр доменов/фабрик до и после каждого теста.

    Гарантирует, что фейковая фабрика из одного теста не протекает в другие
    и что по умолчанию ``has_factory('notifications.push')`` == False.
    """
    domain_registry.reset_registry()
    yield
    domain_registry.reset_registry()


# ── Хелперы ──────────────────────────────────────────────────────────────────


def _register_fake_push_factory() -> MagicMock:
    """Регистрирует фейковую фабрику ``notifications.push``.

    Возвращает мок-сервиса с асинхронным ``push`` — на нём проверяем вызов.
    Фабрика — callable без аргументов, отдающий сервис напрямую (зеркало
    реального контракта _push_factory).
    """
    svc = MagicMock()
    svc.push = AsyncMock(return_value="notif-id-1")

    domain_registry.register_factory("notifications.push", lambda: svc)
    return svc


# ── Контракт push_notification ───────────────────────────────────────────────


async def test_push_called_when_factory_registered():
    """При зарегистрированной фабрике вызывается svc.push с верными полями."""
    svc = _register_fake_push_factory()

    await push_notification(
        source="acts",
        title="Создан акт КМ-01-00001",
        severity="success",
        link="/constructor?act_id=42",
        recipient_user_id="22494524",
    )

    svc.push.assert_awaited_once()
    kwargs = svc.push.await_args.kwargs
    assert kwargs["source"] == "acts"
    assert kwargs["title"] == "Создан акт КМ-01-00001"
    assert kwargs["severity"] == "success"
    assert kwargs["link"] == "/constructor?act_id=42"
    assert kwargs["recipient_user_id"] == "22494524"
    assert kwargs["created_by"] == "system"


async def test_noop_when_factory_absent():
    """Без фабрики эмиссия молча пропускается и не бросает исключений."""
    assert domain_registry.has_factory("notifications.push") is False

    # Не должно поднять исключение.
    await push_notification(
        source="chat",
        title="Готов ответ базы знаний",
        recipient_user_id="22494524",
    )


async def test_swallows_push_error():
    """Сбой svc.push не пробрасывается наружу (основная операция не ломается)."""
    svc = _register_fake_push_factory()
    svc.push = AsyncMock(side_effect=RuntimeError("БД недоступна"))

    # Не должно поднять исключение.
    await push_notification(
        source="acts",
        title="Акт сохранён",
        recipient_user_id="22494524",
    )

    svc.push.assert_awaited_once()


async def test_swallows_factory_error():
    """Сбой при разворачивании фабрики/генератора тоже не пробрасывается."""

    def _bad_factory():
        raise RuntimeError("фабрика сломана")

    domain_registry.register_factory("notifications.push", _bad_factory)

    # Не должно поднять исключение.
    await push_notification(
        source="chat",
        title="Акт сохранён",
        recipient_user_id="22494524",
    )
