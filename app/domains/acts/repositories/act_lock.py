"""
Репозиторий блокировок актов.

Фасад над бэкендом блокировок: имена методов и формы возвратов сохранены с
тех пор, когда блокировка жила в трёх колонках таблицы актов, — сервисам и
``AccessGuard`` не нужно знать, что она переехала на ключ с TTL. Сроки больше
не сравниваются в запросах: истёкшей блокировки просто нет в хранилище.

Хранилище одно — Redis, он обязателен во всех окружениях. Сбой Redis на
мутации пробрасывается наружу (fail-closed): 5xx честнее, чем разъехавшиеся
блокировки и параллельная запись двух редакторов. Fail-open остаётся только
на чтении при обогащении списка актов — см. ``ActCrudService._locks_for``.
"""

import logging

from app.core.redis import get_redis
from app.domains.acts.repositories.act_lock_backends import RedisLockBackend

logger = logging.getLogger("audit_workstation.db.repository.lock")


def get_lock_backend() -> RedisLockBackend:
    """Бэкенд блокировок поверх текущего Redis-адаптера.

    Состояния не держит: объект — тонкая обёртка над адаптером, а сами
    блокировки живут в Redis. Поэтому создаётся на каждый вызов, и подмена
    адаптера (fakeredis в тестах) видна сразу.
    """
    return RedisLockBackend(get_redis())


class ActLockRepository:
    """Атомарные операции блокировок актов."""

    def __init__(self) -> None:
        self._backend = get_lock_backend()

    async def atomic_lock_act(
        self,
        act_id: int,
        username: str,
        duration_minutes: int,
    ) -> dict | None:
        """
        Атомарно захватывает блокировку.

        Повторный захват своим держателем разрешён и означает продление —
        инвариант с времён ``WHERE locked_by IS NULL OR locked_by = $1``.

        Returns:
            dict с locked_by/locked_at/lock_expires_at или None, если акт
            держит другой пользователь
        """
        info = await self._backend.acquire(act_id, username, duration_minutes)
        if info:
            logger.info(
                f"Акт ID={act_id} заблокирован пользователем {username} "
                f"на {duration_minutes} мин"
            )
        return info

    async def atomic_extend_lock(
        self,
        act_id: int,
        username: str,
        duration_minutes: int,
    ) -> dict:
        """
        Атомарно продлевает блокировку.

        Возвращает результат попытки И текущее состояние в одном запросе (без TOCTOU).

        Returns:
            dict с полями: extended (bool), locked_by, lock_expires_at
        """
        result = await self._backend.extend(act_id, username, duration_minutes)
        if result["extended"]:
            logger.info(f"Блокировка акта ID={act_id} продлена на {duration_minutes} мин")
        return result

    async def get_lock_info(self, act_id: int) -> dict | None:
        """Состояние живой блокировки: locked_by, lock_expires_at.

        ``None`` — блокировки нет: либо её не ставили, либо она истекла и ключ
        исчез. Прежняя SQL-версия различала «акта нет» (None) и «акт есть, но
        не заблокирован» (dict с locked_by=None) — оба консьюмера
        (``AccessGuard``, ``ActLockService``) реагировали на них одинаково, а
        несуществующий акт до блокировок не доходит: ``require_*`` отвергает
        его раньше, не найдя пользователя в аудиторской группе.
        """
        return await self._backend.info(act_id)

    async def bulk_lock_info(self, act_ids: list[int]) -> dict[int, dict]:
        """Состояния блокировок пачкой — для списка актов (один MGET).

        Returns:
            dict act_id → состояние блокировки; незаблокированных актов
            в ответе нет
        """
        return await self._backend.bulk_info(act_ids)

    async def unlock_act(self, act_id: int, username: str) -> bool:
        """
        Снимает блокировку с акта.

        Returns:
            True если блокировка была снята, False если пользователь не владеет блокировкой.
        """
        released = await self._backend.release(act_id, username)

        if not released:
            logger.warning(
                f"Попытка снять блокировку с акта ID={act_id} "
                f"пользователем {username}, который не владеет блокировкой"
            )
            return False

        logger.info(f"Блокировка снята с акта ID={act_id} пользователем {username}")
        return True
