"""Тесты продьюсера уведомлений домена acts.

Покрывает контракт ``emit_act_notification`` (эмиссия через фабрику
``notifications.push`` из реестра доменов) и интеграцию в эндпоинт экспорта:

- фабрика зарегистрирована → ``svc.push`` вызывается с верными
  source/severity/link/recipient;
- фабрика отсутствует (``has_factory`` == False) → эмиссия пропускается,
  основная операция не падает (важно для no-regression: в большинстве
  юнит-тестов домен notifications не зарегистрирован);
- ``svc.push`` бросает → исключение НЕ пробрасывается, основная операция
  завершается успешно.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core import domain_registry
from app.domains.acts.services.notifications_producer import emit_act_notification


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


# ── Контракт emit_act_notification ───────────────────────────────────────────


async def test_emit_pushes_when_factory_registered():
    """При зарегистрированной фабрике вызывается svc.push с верными полями."""
    svc = _register_fake_push_factory()

    await emit_act_notification(
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


async def test_emit_noop_when_factory_absent():
    """Без фабрики эмиссия молча пропускается и не бросает исключений."""
    assert domain_registry.has_factory("notifications.push") is False

    # Не должно поднять исключение.
    await emit_act_notification(
        title="Акт сохранён",
        severity="success",
        link="/constructor?act_id=7",
        recipient_user_id="22494524",
    )


async def test_emit_swallows_push_error():
    """Сбой svc.push не пробрасывается наружу (основная операция не ломается)."""
    svc = _register_fake_push_factory()
    svc.push = AsyncMock(side_effect=RuntimeError("БД недоступна"))

    # Не должно поднять исключение.
    await emit_act_notification(
        title="Акт сохранён",
        severity="success",
        link="/constructor?act_id=7",
        recipient_user_id="22494524",
    )

    svc.push.assert_awaited_once()


async def test_emit_swallows_factory_error():
    """Сбой при разворачивании фабрики/генератора тоже не пробрасывается."""

    def _bad_factory():
        raise RuntimeError("фабрика сломана")

    domain_registry.register_factory("notifications.push", _bad_factory)

    # Не должно поднять исключение.
    await emit_act_notification(
        title="Акт сохранён",
        recipient_user_id="22494524",
    )


# ── Интеграция в эндпоинт экспорта save_act ──────────────────────────────────


def _make_act_service() -> MagicMock:
    """ExportService-заглушка: save_act возвращает успешный результат."""
    result = MagicMock()
    result.filename = "act_20260101_120000_abcd.docx"
    svc = MagicMock()
    svc.save_act = AsyncMock(return_value=result)
    return svc


def _make_storage() -> MagicMock:
    storage = MagicMock()
    storage.register_file = MagicMock()
    return storage


def _make_acts_cfg() -> MagicMock:
    cfg = MagicMock()
    cfg.resource.save_act_timeout = 30
    return cfg


async def test_save_act_emits_notification_on_success():
    """Эндпоинт save_act после успешного экспорта эмитит уведомление.

    Патчим emit_act_notification там, где он импортирован (в export.py),
    и проверяем адресность/severity/link. Аудит-лог через get_db — мокаем.
    """
    from app.domains.acts.api import export as export_module

    act_service = _make_act_service()
    storage = _make_storage()
    acts_cfg = _make_acts_cfg()

    # get_db (для аудит-лога) — async-контекст-менеджер с мок-conn.
    db_cm = MagicMock()
    db_cm.__aenter__ = AsyncMock(return_value=AsyncMock())
    db_cm.__aexit__ = AsyncMock(return_value=False)

    with patch.object(export_module, "emit_act_notification", new=AsyncMock()) as mock_emit, \
         patch.object(export_module, "get_db", return_value=db_cm), \
         patch.object(export_module, "ActAuditLogRepository", return_value=MagicMock(log=AsyncMock())):
        result = await export_module.save_act(
            act_id=42,
            fmt="docx",
            username="22494524",
            act_service=act_service,
            storage=storage,
            acts_cfg=acts_cfg,
        )

    assert result.filename == "act_20260101_120000_abcd.docx"
    mock_emit.assert_awaited_once()
    kwargs = mock_emit.await_args.kwargs
    assert kwargs["severity"] == "success"
    assert kwargs["link"] == "/constructor?act_id=42"
    assert kwargs["recipient_user_id"] == "22494524"


async def test_save_act_succeeds_without_notifications_factory():
    """Без фабрики notifications эндпоинт save_act отрабатывает без ошибок.

    Здесь emit_act_notification НЕ патчим — он реально вызывается, но
    has_factory == False (autouse сбросил реестр) → push не зовётся,
    экспорт завершается успешно.
    """
    from app.domains.acts.api import export as export_module

    assert domain_registry.has_factory("notifications.push") is False

    act_service = _make_act_service()
    storage = _make_storage()
    acts_cfg = _make_acts_cfg()

    db_cm = MagicMock()
    db_cm.__aenter__ = AsyncMock(return_value=AsyncMock())
    db_cm.__aexit__ = AsyncMock(return_value=False)

    with patch.object(export_module, "get_db", return_value=db_cm), \
         patch.object(export_module, "ActAuditLogRepository", return_value=MagicMock(log=AsyncMock())):
        result = await export_module.save_act(
            act_id=42,
            fmt="docx",
            username="22494524",
            act_service=act_service,
            storage=storage,
            acts_cfg=acts_cfg,
        )

    assert result.filename == "act_20260101_120000_abcd.docx"
    storage.register_file.assert_called_once()
