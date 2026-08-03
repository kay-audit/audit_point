"""Unit-тесты ActLockService.

Покрывает захват/снятие/продление блокировки акта, разграничение
владельца и обработку истёкших блокировок. Репозитории и AccessGuard
мокаются: проверяем только бизнес-логику сервиса.
"""

from __future__ import annotations

import datetime as dt
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.acts.exceptions import (
    AccessDeniedError,
    ActLockError,
    InsufficientRightsError,
)
from app.domains.acts.services.act_lock_service import ActLockService
from app.domains.acts.settings import ActsSettings, LockSettings


USERNAME = "22494524"
OTHER_USER = "11111111"
ACT_ID = 42


@pytest.fixture(autouse=True)
def _patch_adapter(mock_adapter):
    """Подменяет get_adapter() для BaseRepository — ActAuditLogRepository
    создаётся внутри ActLockService.__init__ и требует адаптер."""
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        yield


def _make_acts_settings(duration_minutes: int = 15) -> ActsSettings:
    """ActsSettings с заданной длительностью блокировки."""
    return ActsSettings(lock=LockSettings(duration_minutes=duration_minutes))


def _make_service(
    *,
    access_perm: dict | None = None,
    has_access: bool | None = None,
    atomic_lock_row: dict | None = None,
    extend_result: dict | None = None,
    unlock_result: bool = True,
    lock_info: dict | None = None,
    duration_minutes: int = 15,
) -> ActLockService:
    """Собирает сервис с замоканными репозиториями.

    access_perm — результат get_user_edit_permission (для require_edit_permission).
    has_access — результат check_user_access (для require_access).
    atomic_lock_row — что вернёт atomic_lock_act.
    extend_result — результат atomic_extend_lock.
    unlock_result — что вернёт unlock_act.
    lock_info — результат get_lock_info (используется в диагностике lock_act).
    """
    conn = MagicMock()  # asyncpg.Connection — внутри сервис не вызывает напрямую

    access = MagicMock()
    if access_perm is None:
        access_perm = {"has_access": True, "can_edit": True, "role": "Куратор"}
    access.get_user_edit_permission = AsyncMock(return_value=access_perm)
    access.check_user_access = AsyncMock(
        return_value=has_access if has_access is not None else True
    )

    lock = MagicMock()
    lock.atomic_lock_act = AsyncMock(return_value=atomic_lock_row)
    lock.atomic_extend_lock = AsyncMock(
        return_value=extend_result
        or {"extended": False, "locked_by": None, "lock_expires_at": None}
    )
    lock.unlock_act = AsyncMock(return_value=unlock_result)
    lock.get_lock_info = AsyncMock(return_value=lock_info)

    settings = MagicMock()
    acts_settings = _make_acts_settings(duration_minutes=duration_minutes)

    service = ActLockService(
        conn=conn,
        settings=settings,
        acts_settings=acts_settings,
        access=access,
        lock=lock,
    )
    # Мокаем audit-репозиторий (создаётся внутри __init__)
    service._audit = MagicMock()
    service._audit.log = AsyncMock()
    return service


# -------------------------------------------------------------------------
# lock_act
# -------------------------------------------------------------------------


class TestLockAct:
    """Захват блокировки."""

    async def test_acquire_lock_when_unlocked_succeeds(self):
        """Если блокировка свободна — atomic_lock_act возвращает row, сервис ОК."""
        expires = dt.datetime(2026, 5, 18, 12, 15)
        service = _make_service(
            atomic_lock_row={
                "locked_by": USERNAME,
                "locked_at": dt.datetime(2026, 5, 18, 12, 0),
                "lock_expires_at": expires,
            },
        )

        result = await service.lock_act(ACT_ID, USERNAME)

        assert result["success"] is True
        assert result["locked_until"] == expires.isoformat()
        # duration_minutes пробрасывается из настроек
        service._lock.atomic_lock_act.assert_awaited_once_with(ACT_ID, USERNAME, 15)
        # Аудит вызван с правильным action
        service._audit.log.assert_awaited_once_with("lock", USERNAME, ACT_ID)

    async def test_acquire_lock_when_locked_by_same_user_extends(self):
        """Повторный lock тем же пользователем проходит — это продление своей блокировки."""
        expires = dt.datetime(2026, 5, 18, 12, 30)
        service = _make_service(
            atomic_lock_row={
                "locked_by": USERNAME,
                "locked_at": dt.datetime(2026, 5, 18, 12, 15),
                "lock_expires_at": expires,
            },
        )

        result = await service.lock_act(ACT_ID, USERNAME)

        assert result["success"] is True
        assert result["locked_until"] == expires.isoformat()

    async def test_acquire_lock_when_locked_by_other_raises(self):
        """Если atomic_lock не сработал и lock_info указывает другого — ActLockError."""
        other_expires = dt.datetime(2026, 5, 18, 12, 30)
        service = _make_service(
            atomic_lock_row=None,
            lock_info={"locked_by": OTHER_USER, "lock_expires_at": other_expires},
        )

        with pytest.raises(ActLockError) as exc_info:
            await service.lock_act(ACT_ID, USERNAME)

        assert exc_info.value.locked_by == OTHER_USER
        assert OTHER_USER in str(exc_info.value)

    async def test_lock_act_no_access_raises_access_denied(self):
        """Если has_access=False — AccessDeniedError, atomic_lock_act даже не вызывается."""
        service = _make_service(
            access_perm={"has_access": False, "can_edit": False, "role": None},
        )

        with pytest.raises(AccessDeniedError):
            await service.lock_act(ACT_ID, USERNAME)

        service._lock.atomic_lock_act.assert_not_awaited()

    async def test_lock_act_viewer_role_raises_insufficient_rights(self):
        """Участник (can_edit=False) не может ставить блокировку."""
        service = _make_service(
            access_perm={"has_access": True, "can_edit": False, "role": "Участник"},
        )

        with pytest.raises(InsufficientRightsError):
            await service.lock_act(ACT_ID, USERNAME)

        service._lock.atomic_lock_act.assert_not_awaited()

    async def test_lock_act_atomic_failed_no_lock_info_raises_generic(self):
        """atomic_lock=None и lock_info=None — generic ActLockError без locked_by."""
        service = _make_service(atomic_lock_row=None, lock_info=None)

        with pytest.raises(ActLockError) as exc_info:
            await service.lock_act(ACT_ID, USERNAME)

        assert exc_info.value.locked_by is None

    async def test_lock_act_uses_configured_duration(self):
        """duration_minutes из ActsSettings.lock пробрасывается в репозиторий."""
        expires = dt.datetime(2026, 5, 18, 12, 45)
        service = _make_service(
            atomic_lock_row={
                "locked_by": USERNAME,
                "locked_at": dt.datetime(2026, 5, 18, 12, 0),
                "lock_expires_at": expires,
            },
            duration_minutes=45,
        )

        await service.lock_act(ACT_ID, USERNAME)

        service._lock.atomic_lock_act.assert_awaited_once_with(ACT_ID, USERNAME, 45)


# -------------------------------------------------------------------------
# unlock_act
# -------------------------------------------------------------------------


class TestUnlockAct:
    """Снятие блокировки."""

    async def test_release_lock_by_owner_succeeds(self):
        """Владелец снимает блокировку — unlock_act возвращает True."""
        service = _make_service(has_access=True, unlock_result=True)

        result = await service.unlock_act(ACT_ID, USERNAME)

        assert result == {"success": True, "message": "Блокировка снята"}
        service._lock.unlock_act.assert_awaited_once_with(ACT_ID, USERNAME)
        service._audit.log.assert_awaited_once_with("unlock", USERNAME, ACT_ID)

    async def test_release_lock_by_non_owner_raises(self):
        """Не-владелец: репозиторий чужую блокировку не снимает → False → ActLockError."""
        service = _make_service(has_access=True, unlock_result=False)

        with pytest.raises(ActLockError) as exc_info:
            await service.unlock_act(ACT_ID, USERNAME)

        assert "не владеете" in str(exc_info.value)
        # Аудит на провалившийся unlock не вызывается
        service._audit.log.assert_not_awaited()

    async def test_unlock_without_access_raises(self):
        """Если check_user_access=False — AccessDeniedError перед unlock."""
        service = _make_service(has_access=False)

        with pytest.raises(AccessDeniedError):
            await service.unlock_act(ACT_ID, USERNAME)

        service._lock.unlock_act.assert_not_awaited()


# -------------------------------------------------------------------------
# extend_lock
# -------------------------------------------------------------------------


class TestExtendLock:
    """Продление блокировки."""

    async def test_extend_lock_succeeds(self):
        """Если блокировка ещё активна и принадлежит пользователю — продление ОК."""
        new_expires = dt.datetime(2026, 5, 18, 13, 0)
        service = _make_service(
            extend_result={
                "extended": True,
                "locked_by": USERNAME,
                "lock_expires_at": new_expires,
            },
        )

        result = await service.extend_lock(ACT_ID, USERNAME)

        assert result["success"] is True
        assert result["locked_until"] == new_expires.isoformat()
        service._lock.atomic_extend_lock.assert_awaited_once_with(ACT_ID, USERNAME, 15)

    async def test_extend_when_not_locked_raises(self):
        """Если блокировки нет — диагностика 'Акт не заблокирован'."""
        service = _make_service(
            extend_result={
                "extended": False,
                "locked_by": None,
                "lock_expires_at": None,
            },
        )

        with pytest.raises(ActLockError) as exc_info:
            await service.extend_lock(ACT_ID, USERNAME)

        assert "не заблокирован" in str(exc_info.value)

    async def test_extend_when_locked_by_other_raises(self):
        """Чужая блокировка — 'не владеете блокировкой'."""
        service = _make_service(
            extend_result={
                "extended": False,
                "locked_by": OTHER_USER,
                "lock_expires_at": dt.datetime(2026, 5, 18, 12, 30),
            },
        )

        with pytest.raises(ActLockError) as exc_info:
            await service.extend_lock(ACT_ID, USERNAME)

        assert "не владеете" in str(exc_info.value)

    async def test_extend_when_lock_expired_raises(self):
        """locked_by == username, но extended=False → блокировка истекла."""
        service = _make_service(
            extend_result={
                "extended": False,
                "locked_by": USERNAME,
                "lock_expires_at": dt.datetime(2026, 5, 18, 11, 0),
            },
        )

        with pytest.raises(ActLockError) as exc_info:
            await service.extend_lock(ACT_ID, USERNAME)

        assert "истекла" in str(exc_info.value)

    async def test_extend_no_access_raises(self):
        """Нет доступа к акту — AccessDeniedError перед extend."""
        service = _make_service(
            access_perm={"has_access": False, "can_edit": False, "role": None},
        )

        with pytest.raises(AccessDeniedError):
            await service.extend_lock(ACT_ID, USERNAME)

        service._lock.atomic_extend_lock.assert_not_awaited()

    async def test_extend_viewer_role_raises_insufficient_rights(self):
        """Участник не может продлевать блокировку (нет права на редактирование)."""
        service = _make_service(
            access_perm={"has_access": True, "can_edit": False, "role": "Участник"},
        )

        with pytest.raises(InsufficientRightsError):
            await service.extend_lock(ACT_ID, USERNAME)

        service._lock.atomic_extend_lock.assert_not_awaited()
