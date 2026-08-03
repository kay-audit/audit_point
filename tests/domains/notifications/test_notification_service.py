"""Тесты сервиса центра уведомлений.

Сервис — тонкая обёртка над репозиторием: проверяем делегирование и то,
что push генерирует id и передаёт created_by.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.notifications.services.notification_service import (
    NotificationService,
)


@pytest.fixture
def service():
    """NotificationService с замоканным репозиторием (conn не используется)."""
    with patch(
        "app.domains.notifications.services.notification_service.NotificationRepository"
    ) as RepoCls:
        repo = MagicMock()
        repo.list_for_user = AsyncMock(return_value=[{"id": "n1"}])
        repo.unread_summary = AsyncMock(
            return_value={"count": 5, "severity": "warning"}
        )
        repo.mark_read = AsyncMock()
        repo.mark_unread = AsyncMock()
        repo.mark_all_read = AsyncMock()
        repo.dismiss = AsyncMock()
        repo.create = AsyncMock(return_value="generated-id")
        RepoCls.return_value = repo
        svc = NotificationService(conn=MagicMock())
        svc._repo_mock = repo  # для ассертов в тестах
        yield svc


async def test_list_for_user_delegates(service):
    """list_for_user делегирует в repo с limit."""
    result = await service.list_for_user("user1", limit=20)
    assert result == [{"id": "n1"}]
    service._repo_mock.list_for_user.assert_awaited_once_with("user1", limit=20)


async def test_unread_summary_delegates(service):
    """unread_summary делегирует в repo (count + severity)."""
    assert await service.unread_summary("user1") == {
        "count": 5,
        "severity": "warning",
    }
    service._repo_mock.unread_summary.assert_awaited_once_with("user1")


async def test_mark_read_delegates(service):
    """mark_read делегирует в repo."""
    await service.mark_read("n1", "user1")
    service._repo_mock.mark_read.assert_awaited_once_with("n1", "user1")


async def test_mark_unread_delegates(service):
    """mark_unread делегирует в repo."""
    await service.mark_unread("n1", "user1")
    service._repo_mock.mark_unread.assert_awaited_once_with("n1", "user1")


async def test_mark_all_read_delegates(service):
    """mark_all_read делегирует в repo."""
    await service.mark_all_read("user1")
    service._repo_mock.mark_all_read.assert_awaited_once_with("user1")


async def test_dismiss_delegates(service):
    """dismiss делегирует в repo."""
    await service.dismiss("n1", "user1")
    service._repo_mock.dismiss.assert_awaited_once_with("n1", "user1")


async def test_push_generates_id_and_returns_it(service):
    """push возвращает id (из repo.create) и генерирует uuid для create."""
    with patch(
        "app.domains.notifications.services.notification_service.uuid"
    ) as mock_uuid:
        mock_uuid.uuid4.return_value = "fixed-uuid"
        result = await service.push(source="acts", title="Готов акт")

    assert result == "generated-id"
    kwargs = service._repo_mock.create.await_args.kwargs
    assert kwargs["id"] == "fixed-uuid"
    assert kwargs["source"] == "acts"
    assert kwargs["title"] == "Готов акт"
    # дефолты
    assert kwargs["severity"] == "info"
    assert kwargs["recipient_user_id"] is None
    assert kwargs["created_by"] == "system"


async def test_push_passes_created_by_and_recipient(service):
    """push прокидывает created_by и recipient_user_id в repo.create."""
    await service.push(
        source="manual",
        title="Лично тебе",
        severity="warning",
        recipient_user_id="user2",
        created_by="user1",
        link="/constructor?act_id=7",
    )
    kwargs = service._repo_mock.create.await_args.kwargs
    assert kwargs["created_by"] == "user1"
    assert kwargs["recipient_user_id"] == "user2"
    assert kwargs["severity"] == "warning"
    assert kwargs["link"] == "/constructor?act_id=7"


# ── Redis-кэш unread_summary ────────────────────────────────────────────────
#
# get_redis импортирован в notification_service на module-level, поэтому
# патчится по пути самого модуля сервиса (не app.core.redis).

_GET_REDIS = "app.domains.notifications.services.notification_service.get_redis"


def _redis_mock():
    """MagicMock RedisAdapter с async-методами, которые реально дёргает сервис."""
    m = MagicMock()
    m.mget = AsyncMock(return_value=[None, None])  # обе эпохи отсутствуют → "0"
    m.get_json = AsyncMock(return_value=None)
    m.set_json = AsyncMock(return_value=True)
    m.delete = AsyncMock(return_value=1)
    m.incr = AsyncMock(return_value=1)
    return m


@pytest.fixture
def redis():
    return _redis_mock()


async def test_unread_summary_cache_hit_skips_sql(service, redis):
    """Хит кэша — результат из Redis, repo.unread_summary НЕ вызывается."""
    redis.get_json = AsyncMock(return_value={"count": 2, "severity": "info"})

    with patch(_GET_REDIS, return_value=redis):
        result = await service.unread_summary("user1")

    assert result == {"count": 2, "severity": "info"}
    service._repo_mock.unread_summary.assert_not_awaited()


async def test_unread_summary_cache_miss_writes_through(service, redis):
    """Промах кэша — читаем из БД и сохраняем результат в Redis с TTL=600с."""
    with patch(_GET_REDIS, return_value=redis):
        result = await service.unread_summary("user1")

    assert result == {"count": 5, "severity": "warning"}
    service._repo_mock.unread_summary.assert_awaited_once_with("user1")
    redis.mget.assert_awaited_once_with(["cache:notif:epoch", "cache:notif:uver:user1"])
    redis.set_json.assert_awaited_once_with(
        "cache:notif:unread:user1:v0:u0", {"count": 5, "severity": "warning"}, ex=600
    )


async def test_unread_summary_redis_error_falls_back_to_sql(service, redis):
    """Сбой Redis на чтении — честный SQL-путь, исключение наружу не летит."""
    redis.get_json = AsyncMock(side_effect=ConnectionError("boom"))

    with patch(_GET_REDIS, return_value=redis):
        result = await service.unread_summary("user1")  # не должно бросить

    assert result == {"count": 5, "severity": "warning"}
    service._repo_mock.unread_summary.assert_awaited_once_with("user1")


async def test_unread_summary_redis_write_error_still_returns_sql_result(service, redis):
    """Сбой Redis на записи в кэш — результат из БД всё равно возвращается."""
    redis.set_json = AsyncMock(side_effect=ConnectionError("boom"))

    with patch(_GET_REDIS, return_value=redis):
        result = await service.unread_summary("user1")  # не должно бросить

    assert result == {"count": 5, "severity": "warning"}


async def test_push_broadcast_increments_epoch(service, redis):
    """push без recipient_user_id (broadcast) — INCR всей эпохи, без DEL."""
    with patch(_GET_REDIS, return_value=redis):
        await service.push(source="acts", title="Готов акт")

    redis.incr.assert_awaited_once_with("cache:notif:epoch")
    redis.delete.assert_not_awaited()


async def test_push_addressed_bumps_recipient_epoch(service, redis):
    """push с recipient_user_id — INCR персональной эпохи получателя, без DEL."""
    with patch(_GET_REDIS, return_value=redis):
        await service.push(source="manual", title="Т", recipient_user_id="user2")

    redis.incr.assert_awaited_once_with("cache:notif:uver:user2")
    redis.delete.assert_not_awaited()


@pytest.mark.parametrize(
    "method,args",
    [
        ("mark_read", ("n1", "user1")),
        ("mark_unread", ("n1", "user1")),
        ("dismiss", ("n1", "user1")),
        ("mark_all_read", ("user1",)),
    ],
)
async def test_mutation_bumps_caller_epoch(service, redis, method, args):
    """mark_read/mark_unread/dismiss/mark_all_read — INCR эпохи вызывающего юзера.

    Именно INCR, а не DEL: иначе тик колокольчика, начавший считать агрегат до
    мутации, дописал бы устаревшее число уже после неё — и бейдж врал бы 10 минут.
    """
    with patch(_GET_REDIS, return_value=redis):
        await getattr(service, method)(*args)

    redis.incr.assert_awaited_once_with("cache:notif:uver:user1")
    redis.delete.assert_not_awaited()


async def test_mutation_redis_error_does_not_propagate(service, redis):
    """Сбой Redis при инвалидации — предупреждение в лог, исключение не летит наружу."""
    redis.incr = AsyncMock(side_effect=ConnectionError("boom"))

    with patch(_GET_REDIS, return_value=redis):
        await service.mark_read("n1", "user1")  # не должно бросить

    service._repo_mock.mark_read.assert_awaited_once_with("n1", "user1")


# ── Регрессия: гонка «инвалидация во время подсчёта агрегата» ────────────────
#
# Redis здесь настоящий (fakeredis из autouse-фикстуры) — нужна реальная
# семантика INCR и раздельных ключей эпох.


async def test_write_after_invalidation_lands_in_dead_key(service, fake_redis):
    """Уведомление прочитали, пока шёл подсчёт: запись уходит в мёртвый ключ."""
    counts = [{"count": 5, "severity": "warning"}, {"count": 0, "severity": None}]

    async def _unread_summary(user_id):
        if len(counts) == 2:
            # Агрегат ещё считается, а пользователь уже пометил уведомление прочитанным
            await service.mark_read("n1", user_id)
        return counts.pop(0)

    service._repo_mock.unread_summary = AsyncMock(side_effect=_unread_summary)

    first = await service.unread_summary("user1")
    second = await service.unread_summary("user1")

    assert first == {"count": 5, "severity": "warning"}
    # Следующий тик колокольчика видит актуальное число, а не кэш прошлой эпохи
    assert second == {"count": 0, "severity": None}

    stale = await fake_redis.get_json("cache:notif:unread:user1:v0:u0")
    assert stale == {"count": 5, "severity": "warning"}  # мёртвый ключ
    fresh = await fake_redis.get_json("cache:notif:unread:user1:v0:u1")
    assert fresh == {"count": 0, "severity": None}
