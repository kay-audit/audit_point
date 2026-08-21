"""
Репозиторий картинок нарушений (таблица ``act_images``).

Байты картинок вынесены из JSONB-полей ``act_violations``: блок-картинка
нарушения хранит только ``image_id``. Адресация всегда ПАРОЙ
``(act_id, image_id)`` — акт-владелец обязателен в каждом запросе, чтобы
знание чужого uuid не давало доступа к чужой картинке (на Greenplum это
заодно попадает в ключ распределения ``DISTRIBUTED BY (act_id)``).
"""

import json
import logging
from typing import Any, Iterable

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.acts.violation_fields import VIOLATION_FIELDS

logger = logging.getLogger("audit_workstation.db.repository.act_image")

# Минимальный возраст картинки, при котором сборщик мусора имеет право её
# удалить. Свежезагруженная картинка какое-то время ни в контенте, ни в
# версиях не упоминается: пользователь вставил её в блок, но PUT /content
# ещё не прошёл. Без этой отсрочки параллельное сохранение ДРУГОГО редактора
# успело бы посчитать её мусором и удалить прямо из-под наборщика. Значение
# намеренно константа, а не настройка: это внутренняя страховка GC, крутить
# её из .env незачем.
GC_MIN_AGE_MINUTES = 60


def _collect_image_ids(container: Any, sink: set[str]) -> None:
    """Складывает в ``sink`` все ``image_id`` из контейнера поля нарушения.

    Контейнер — ``{enabled, blocks}``; берём ``image_id`` у блоков с
    ``type == 'image'``. Любая другая форма (None, скаляр, повреждённые
    данные) молча пропускается: сборщик мусора обязан быть консервативным,
    непонятая структура НЕ должна приводить к удалению картинок.
    """
    if not isinstance(container, dict):
        return
    blocks = container.get("blocks")
    if not isinstance(blocks, list):
        return
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "image":
            continue
        image_id = block.get("image_id")
        if isinstance(image_id, str) and image_id:
            sink.add(image_id)


def _loads(raw: Any) -> Any:
    """JSONB-значение как объект Python (адаптеры отдают str или dict)."""
    if isinstance(raw, (str, bytes)):
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return None
    return raw


class ActImageRepository(BaseRepository):
    """CRUD и сборка мусора картинок нарушений."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.images_table = self.adapter.get_table_name("act_images")
        self.violations_table = self.adapter.get_table_name("act_violations")
        self.versions_table = self.adapter.get_table_name("act_content_versions")

    # ------------------------------------------------------------------
    # ЗАПИСЬ
    # ------------------------------------------------------------------

    async def find_id_by_hash(self, act_id: int, content_hash: str) -> str | None:
        """id уже загруженной в этот акт картинки с таким sha256 (или None)."""
        return await self.conn.fetchval(
            f"""
            SELECT id FROM {self.images_table}
            WHERE act_id = $1 AND content_hash = $2
            """,
            act_id,
            content_hash,
        )

    async def create(
        self,
        *,
        act_id: int,
        image_id: str,
        content_hash: str,
        mime_type: str,
        byte_size: int,
        data: bytes,
        created_by: str,
    ) -> None:
        """Вставляет строку картинки.

        ``ON CONFLICT`` недоступен на Greenplum — гонку двух параллельных
        загрузок одного и того же файла разруливает вызывающий сервис:
        ловит ``UniqueViolationError`` по ``UNIQUE (act_id, content_hash)``
        и повторяет поиск по хэшу.
        """
        await self.conn.execute(
            f"""
            INSERT INTO {self.images_table}
                (id, act_id, content_hash, mime_type, byte_size, data, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            image_id,
            act_id,
            content_hash,
            mime_type,
            byte_size,
            data,
            created_by,
        )

    # ------------------------------------------------------------------
    # ЧТЕНИЕ
    # ------------------------------------------------------------------

    async def get(self, act_id: int, image_id: str) -> dict | None:
        """Байты и метаданные одной картинки акта (или None)."""
        row = await self.conn.fetchrow(
            f"""
            SELECT id, mime_type, byte_size, data
            FROM {self.images_table}
            WHERE id = $1 AND act_id = $2
            """,
            image_id,
            act_id,
        )
        return dict(row) if row else None

    async def get_many(self, act_id: int, image_ids: Iterable[str]) -> dict[str, dict]:
        """Байты нескольких картинок акта одним запросом: ``{id: строка}``.

        Один SELECT вместо N — экспорт подгружает все картинки акта ДО
        построения документа, поэтому внутри рендера (он идёт в пуле потоков,
        без event loop) обращений к БД уже нет.
        """
        ids = [i for i in dict.fromkeys(image_ids) if i]
        if not ids:
            return {}
        rows = await self.conn.fetch(
            f"""
            SELECT id, mime_type, byte_size, data
            FROM {self.images_table}
            WHERE act_id = $1 AND id = ANY($2::varchar[])
            """,
            act_id,
            ids,
        )
        return {row["id"]: dict(row) for row in rows}

    async def total_size(self, act_id: int) -> int:
        """Суммарный вес картинок акта в байтах.

        Считается запросом к ``act_images``, а не обходом JSONB нарушений:
        бюджет акта — свойство хранилища, а не текущего снимка контента
        (иначе только что загруженная, но ещё не сохранённая картинка в
        бюджет бы не попала).
        """
        value = await self.conn.fetchval(
            f"SELECT COALESCE(SUM(byte_size), 0) FROM {self.images_table} WHERE act_id = $1",
            act_id,
        )
        return int(value or 0)

    # ------------------------------------------------------------------
    # СБОРКА МУСОРА
    # ------------------------------------------------------------------

    async def collect_live_image_ids(self, act_id: int) -> set[str]:
        """Множество ``image_id``, на которые реально ссылается акт.

        Источников ровно два и оба обязательны:

        1. АКТУАЛЬНЫЙ контент — полевые JSONB-колонки ``act_violations``;
        2. ВСЕ сохранённые версии — ``act_content_versions.violations_data``
           (иначе восстановление версии вернуло бы битые ссылки).

        Порядок вызова важен: множество считается ПОСЛЕ записи контента и
        ПОСЛЕ вставки новой версии, иначе только что сохранённые ссылки в
        него не попадут.
        """
        live: set[str] = set()

        columns = ", ".join(f.column for f in VIOLATION_FIELDS)
        rows = await self.conn.fetch(
            f"SELECT {columns} FROM {self.violations_table} WHERE act_id = $1",
            act_id,
        )
        for row in rows:
            for field in VIOLATION_FIELDS:
                _collect_image_ids(_loads(row[field.column]), live)

        version_rows = await self.conn.fetch(
            f"SELECT violations_data FROM {self.versions_table} WHERE act_id = $1",
            act_id,
        )
        for row in version_rows:
            snapshot = _loads(row["violations_data"])
            if not isinstance(snapshot, dict):
                continue
            for violation in snapshot.values():
                if not isinstance(violation, dict):
                    continue
                for field in VIOLATION_FIELDS:
                    _collect_image_ids(violation.get(field.key), live)

        return live

    async def delete_unreferenced(self, act_id: int, live_ids: set[str]) -> int:
        """Удаляет картинки акта, которых нет в ``live_ids``. Возвращает счёт.

        Удаляются только картинки старше ``GC_MIN_AGE_MINUTES`` — свежая
        загрузка, ещё не дошедшая до сохранённого контента, неприкосновенна.
        """
        params: list[Any] = [act_id]
        exclude = ""
        if live_ids:
            params.append(sorted(live_ids))
            exclude = " AND id <> ALL($2::varchar[])"
        result = await self.conn.execute(
            f"""
            DELETE FROM {self.images_table}
            WHERE act_id = $1
              AND created_at < CURRENT_TIMESTAMP - INTERVAL '{GC_MIN_AGE_MINUTES} minutes'
              {exclude}
            """,
            *params,
        )
        deleted = int(result.split()[-1]) if result else 0
        if deleted:
            logger.info(f"Удалено {deleted} несвязанных картинок акта ID={act_id}")
        return deleted

    async def delete_for_act(self, act_id: int) -> int:
        """Удаляет все картинки акта (используется при удалении акта на GP)."""
        result = await self.conn.execute(
            f"DELETE FROM {self.images_table} WHERE act_id = $1",
            act_id,
        )
        return int(result.split()[-1]) if result else 0
