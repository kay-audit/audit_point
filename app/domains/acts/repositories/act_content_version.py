"""
Репозиторий версий содержимого актов.

Создаёт снэпшоты содержимого при manual/periodic сохранении
для просмотра истории и восстановления.
"""

import hashlib
import json
import logging

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn

logger = logging.getLogger("audit_workstation.db.repository.content_version")

# Волатильные поля записи фактуры: суррогатный ключ и таймстемпы БД. Исключаем
# из хэша содержимого — иначе повторное чтение неизменных фактур (updated_at
# бампается UPSERT-синхронизацией при каждом сохранении) ложно ломало бы дедуп.
_VOLATILE_INVOICE_FIELDS = ("id", "created_at", "updated_at")


def compute_content_hash(
    tree: dict, tables: dict, textblocks: dict, violations: dict, invoices: dict | None,
) -> str:
    """Канонический SHA-256 содержимого снимка версии.

    Стабильная сериализация (`sort_keys` + компактные разделители) — логически
    равные документы дают равный хэш независимо от порядка ключей. Волатильные
    поля фактур (`id`/таймстемпы БД) исключаются, чтобы не ломать дедуп. Ключи
    актового JSON машинные (ASCII), поэтому stdlib-канонизации достаточно —
    отдельная RFC-8785 библиотека не нужна.

    Содержимое сериализуется здесь отдельно от блоба хранения (у него своя
    сериализация по полям) — осознанный размен: канонизация ради стабильного
    хэша важнее экономии одной лишней сериализации на не-горячем пути.
    """
    payload = {
        "tree": tree,
        "tables": tables,
        "textblocks": textblocks,
        "violations": violations,
        "invoices": {
            node_id: {
                k: v for k, v in rec.items() if k not in _VOLATILE_INVOICE_FIELDS
            }
            for node_id, rec in (invoices or {}).items()
        },
    }
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"),
        ensure_ascii=False, default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class ActContentVersionRepository(BaseRepository):
    """Версионирование содержимого актов."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.versions_table = self.adapter.get_table_name("act_content_versions")

    async def create_version(
        self,
        act_id: int,
        username: str,
        save_type: str,
        tree: dict,
        tables: dict,
        textblocks: dict,
        violations: dict,
        invoices: dict | None = None,
        max_versions: int = 50,
    ) -> int | None:
        """
        Создаёт новый снэпшот. Возвращает version_number, либо None если снимок
        не создавался (содержимое совпало с последней версией — дедуп).

        Дедупликация: считаем канонический хэш содержимого и сравниваем с хэшем
        последней версии акта; при совпадении INSERT пропускаем — no-op ручное
        сохранение не плодит версию-дубль и не вытесняет реальную из кольца
        (max_versions). Дедуп best-effort (без блокировок): редкий гоночный
        дубль безвреден, история остаётся корректной.

        Хэш покрывает только содержимое (tree/tables/textblocks/violations/
        invoices), но НЕ метаданные события (save_type/username/время). Поэтому
        manual-сохранение с контентом, идентичным предыдущему снимку, версию не
        создаёт — отметка «кто/когда сохранял» в список версий не попадёт (в
        аудит-лог content_save/restore — попадёт, это отдельный источник).

        Ошибки БД ПРОБРАСЫВАЮТСЯ (не глотаются): вызывающие сервисы держат
        снимок версии в одной плоской транзакции с записью контента —
        сбой снимка обязан откатить всё (§9 зона 4). Глотание исключения
        внутри открытой транзакции к тому же оставило бы её в
        aborted-состоянии и уронило бы последующие запросы.

        Args:
            act_id: ID акта
            username: Пользователь
            save_type: Тип сохранения (manual, periodic)
            tree: Данные дерева
            tables: Данные таблиц
            textblocks: Данные текстовых блоков
            violations: Данные нарушений
            invoices: Данные фактур акта (привязка node_id → реквизиты); None → {}
            max_versions: Максимальное число версий (старые удаляются)
        """
        content_hash = compute_content_hash(tree, tables, textblocks, violations, invoices)

        # Дедуп: если содержимое совпало с последней версией — снимок не создаём.
        # NULL last_hash (версий нет / старая строка без хэша) → создаём.
        last_hash = await self.conn.fetchval(
            f"""
            SELECT content_hash FROM {self.versions_table}
            WHERE act_id = $1
            ORDER BY version_number DESC
            LIMIT 1
            """,
            act_id,
        )
        if last_hash is not None and last_hash == content_hash:
            logger.debug(
                f"Версия акта ID={act_id} не создана: содержимое не изменилось "
                f"(save_type={save_type}, user={username})"
            )
            return None

        tree_json = json.dumps(tree, ensure_ascii=False, default=str)
        tables_json = json.dumps(tables, ensure_ascii=False, default=str)
        textblocks_json = json.dumps(textblocks, ensure_ascii=False, default=str)
        violations_json = json.dumps(violations, ensure_ascii=False, default=str)
        invoices_json = json.dumps(invoices or {}, ensure_ascii=False, default=str)

        # Атомарный INSERT с вычислением version_number
        row = await self.conn.fetchrow(
            f"""
            INSERT INTO {self.versions_table}
                (act_id, version_number, save_type, username,
                 tree_data, tables_data, textblocks_data, violations_data,
                 invoices_data, content_hash)
            SELECT $1::bigint, COALESCE(MAX(version_number), 0) + 1, $2, $3,
                   $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9
            FROM {self.versions_table}
            WHERE act_id = $1
            RETURNING version_number
            """,
            act_id,
            save_type,
            username,
            tree_json,
            tables_json,
            textblocks_json,
            violations_json,
            invoices_json,
            content_hash,
        )
        next_version = row["version_number"]

        # Удалить старые версии если превышен лимит
        await self._cleanup_old_versions(act_id, max_versions)

        logger.info(
            f"Создана версия #{next_version} акта ID={act_id} "
            f"(save_type={save_type}, user={username})"
        )
        return next_version

    async def get_versions_list(
        self, act_id: int, *, limit: int = 50, offset: int = 0,
    ) -> tuple[list[dict], int]:
        """Список версий (без данных содержимого)."""
        count_row = await self.conn.fetchrow(
            f"SELECT COUNT(*) AS cnt FROM {self.versions_table} WHERE act_id = $1",
            act_id,
        )
        total = count_row["cnt"]

        rows = await self.conn.fetch(
            f"""
            SELECT id, version_number, save_type, username, created_at
            FROM {self.versions_table}
            WHERE act_id = $1
            ORDER BY version_number DESC
            LIMIT $2 OFFSET $3
            """,
            act_id,
            limit,
            offset,
        )
        items = [dict(r) for r in rows]
        return items, total

    async def get_version(self, act_id: int, version_id: int) -> dict | None:
        """Полный снэпшот конкретной версии для просмотра/восстановления."""
        row = await self.conn.fetchrow(
            f"""
            SELECT id, version_number, save_type, username,
                   tree_data, tables_data, textblocks_data, violations_data,
                   invoices_data, created_at
            FROM {self.versions_table}
            WHERE act_id = $1 AND id = $2
            """,
            act_id,
            version_id,
        )
        if not row:
            return None

        result = dict(row)
        # Конвертируем JSONB-строки в dict при необходимости
        for key in ("tree_data", "tables_data", "textblocks_data",
                    "violations_data", "invoices_data"):
            val = result.get(key)
            if isinstance(val, str):
                result[key] = json.loads(val)
        return result

    async def _cleanup_old_versions(self, act_id: int, max_versions: int) -> int:
        """Удаляет старые версии, оставляя последние max_versions."""
        result = await self.conn.execute(
            f"""
            DELETE FROM {self.versions_table}
            WHERE act_id = $1
              AND id NOT IN (
                  SELECT id FROM {self.versions_table}
                  WHERE act_id = $1
                  ORDER BY version_number DESC
                  LIMIT $2
              )
            """,
            act_id,
            max_versions,
        )
        # result: "DELETE N"
        deleted = int(result.split()[-1]) if result else 0
        if deleted > 0:
            logger.info(f"Удалено {deleted} старых версий акта ID={act_id}")
        return deleted
