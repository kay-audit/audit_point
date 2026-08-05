"""Репозиторий фото профиля пользователя."""

import logging
from datetime import datetime

import asyncpg

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn

logger = logging.getLogger("audit_workstation.domains.admin.repo.user_avatars")


class UserAvatarRepository(BaseRepository):
    """Фото профиля: одна строка на пользователя, ключ — его логин.

    Справочник пользователей наполняется ETL и доступен только на чтение —
    фото живёт в отдельной таблице приложения.
    """

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.table = self.adapter.get_table_name("user_avatars")

    async def get(self, user_id: str) -> dict | None:
        """Возвращает ``{image, mime, updated_at}`` или None, если фото нет."""
        row = await self.conn.fetchrow(
            f"SELECT image, mime, updated_at FROM {self.table} WHERE user_id = $1",
            user_id,
        )
        return dict(row) if row else None

    async def get_updated_at(self, user_id: str) -> datetime | None:
        """Время последней загрузки без выборки самих байтов.

        Нужно для ``avatar_version`` в /me: тянуть картинку целиком ради
        одной метки времени на каждой загрузке страницы не стоит.
        """
        return await self.conn.fetchval(
            f"SELECT updated_at FROM {self.table} WHERE user_id = $1",
            user_id,
        )

    async def upsert(self, user_id: str, image: bytes, mime: str) -> None:
        """Сохраняет фото пользователя, заменяя прежнее.

        UPDATE, и только при отсутствии строки — INSERT: ``ON CONFLICT``
        недоступен на Greenplum (PG 9.5+). PRIMARY KEY (user_id входит и в
        distribution key, поэтому GP констрейнт тоже соблюдает) закрывает
        гонку двух параллельных ПЕРВЫХ загрузок на уровне данных — дублей
        не будет. Но между нашим UPDATE 0 и INSERT может вклиниться
        конкурент: тогда INSERT ловит UniqueViolationError, и мы повторяем
        UPDATE — строка к этому моменту уже есть.
        ``updated_at`` выставляется явно — триггеров в проекте нет.
        """
        for attempt in range(2):
            result = await self.conn.execute(
                f"""
                UPDATE {self.table}
                SET image = $2, mime = $3, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $1
                """,
                user_id,
                image,
                mime,
            )
            if result != "UPDATE 0":
                return

            try:
                await self.conn.execute(
                    f"INSERT INTO {self.table} (user_id, image, mime) VALUES ($1, $2, $3)",
                    user_id,
                    image,
                    mime,
                )
                return
            except asyncpg.UniqueViolationError:
                if attempt == 0:
                    continue
                raise

    async def delete(self, user_id: str) -> bool:
        """Удаляет фото. True — строка была, False — удалять было нечего."""
        result = await self.conn.execute(
            f"DELETE FROM {self.table} WHERE user_id = $1",
            user_id,
        )
        return result == "DELETE 1"
