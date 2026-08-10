"""
Репозиторий аудит-лога.

Записывает чувствительные операции для compliance-отчётности.
Вычисляет diff содержимого при content_save.
"""

import json
import logging
from dataclasses import dataclass
from datetime import date, datetime

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.db.utils.json_db_utils import JSONDBUtils
from app.domains.acts.repositories import violation_row_mapper
from app.domains.acts.violation_fields import VIOLATION_FIELDS


@dataclass(frozen=True, slots=True)
class ActAuditLogRecord:
    """Одна запись аудит-лога актов для bulk-INSERT через ``log_many``."""
    action: str
    username: str
    act_id: int | None = None
    details: dict | None = None
    changelog: list[dict] | None = None

logger = logging.getLogger("audit_workstation.db.repository.audit_log")

# Разрешённые поля для динамической фильтрации в get_log.
# Любое имя поля вне этого множества → ValueError (защита от SQL-инъекции).
_ALLOWED_FILTER_FIELDS: frozenset[str] = frozenset({
    "act_id",
    "action",
    "username",
    "created_at",
})


class ActAuditLogRepository(BaseRepository):
    """Запись и чтение операций аудит-лога."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.audit_log = self.adapter.get_table_name("audit_log")
        self._tables = self.adapter.get_table_name("act_tables")
        self._textblocks = self.adapter.get_table_name("act_textblocks")
        self._violations = self.adapter.get_table_name("act_violations")
        self._tree = self.adapter.get_table_name("act_tree")

    async def log(
        self,
        action: str,
        username: str,
        act_id: int | None = None,
        details: dict | None = None,
        changelog: list[dict] | None = None,
    ) -> None:
        """
        Записывает операцию в аудит-лог.

        Args:
            action: Тип операции (create, update, delete, duplicate, lock, unlock,
                    content_save, save_invoice, export, download, restore)
            username: Пользователь
            act_id: ID акта (опционально)
            details: Дополнительные данные (опционально)
            changelog: Гранулярный лог локальных изменений (опционально)

        Если в процессе уже стартовал ``ActAuditLogBatcher``, запись уходит
        в батчер для bulk-INSERT'а пакетами. Иначе — fallback на одиночный
        INSERT (тесты, ранний startup, отключённый батчер).
        """
        # Ленивый импорт — избегаем циклической зависимости с deps.py.
        try:
            from app.domains.acts.deps import get_audit_log_batcher
            batcher = get_audit_log_batcher()
        except Exception:
            batcher = None

        if batcher is not None:
            try:
                await batcher.add(
                    ActAuditLogRecord(
                        action=action,
                        username=username,
                        act_id=act_id,
                        details=details,
                        changelog=changelog,
                    )
                )
                return
            except Exception:
                # Падение батчера не должно блокировать основную операцию —
                # пишем синхронным fallback'ом.
                logger.warning(
                    "Не удалось положить запись в audit-log батчер, "
                    "fallback на синхронный INSERT",
                    exc_info=True,
                )

        details_json = json.dumps(details or {}, ensure_ascii=False, default=str)
        changelog_json = json.dumps(changelog or [], ensure_ascii=False, default=str)
        try:
            await self.conn.execute(
                f"""
                INSERT INTO {self.audit_log} (act_id, action, username, details, changelog)
                VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
                """,
                act_id,
                action,
                username,
                details_json,
                changelog_json,
            )
        except Exception:
            # Ошибка записи аудит-лога не должна блокировать основную операцию
            logger.exception(
                f"Не удалось записать аудит-лог: action={action}, "
                f"act_id={act_id}, username={username}"
            )

    async def log_many(self, records: list[ActAuditLogRecord]) -> None:
        """Bulk-INSERT пакета записей аудит-лога одним ``executemany``
        в транзакции.

        Используется батчером (``ActAuditLogBatcher``) для снижения числа
        одиночных INSERT'ов на Greenplum: десятки операций пользователя
        в минуту → один пакет в 30 секунд или при наборе ``batch_size``.

        Пустой список — no-op. JSON-сериализация ``details`` / ``changelog``
        выполняется по тем же правилам, что и в ``log()``.
        """
        if not records:
            return
        params = []
        for r in records:
            details_json = json.dumps(r.details or {}, ensure_ascii=False, default=str)
            changelog_json = json.dumps(r.changelog or [], ensure_ascii=False, default=str)
            params.append((r.act_id, r.action, r.username, details_json, changelog_json))
        async with self.conn.transaction():
            await self.conn.executemany(
                f"""
                INSERT INTO {self.audit_log} (act_id, action, username, details, changelog)
                VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
                """,
                params,
            )

    # -------------------------------------------------------------------------
    # ЧТЕНИЕ
    # -------------------------------------------------------------------------

    async def get_log(
        self,
        act_id: int,
        *,
        action: str | None = None,
        username: str | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        """Записи аудит-лога с фильтрацией и пагинацией."""
        where = ["act_id = $1"]
        params: list = [act_id]
        idx = 2

        def _check_field(field_name: str) -> str:
            """Проверяет имя поля по whitelist. Защита от SQL-инъекции."""
            if field_name not in _ALLOWED_FILTER_FIELDS:
                raise ValueError(
                    f"Недопустимое поле фильтрации: '{field_name}'. "
                    f"Разрешены: {sorted(_ALLOWED_FILTER_FIELDS)}"
                )
            return field_name

        if action:
            actions = [a.strip() for a in action.split(",") if a.strip()]
            col = _check_field("action")
            if len(actions) == 1:
                where.append(f"{col} = ${idx}")
                params.append(actions[0])
                idx += 1
            elif actions:
                placeholders = ", ".join(f"${idx + i}" for i in range(len(actions)))
                where.append(f"{col} IN ({placeholders})")
                params.extend(actions)
                idx += len(actions)
        if username:
            col = _check_field("username")
            where.append(f"{col} ILIKE ${idx}")
            params.append(f"%{username}%")
            idx += 1
        if from_date:
            col = _check_field("created_at")
            where.append(f"{col} >= ${idx}")
            parsed = datetime.fromisoformat(from_date) if "T" in from_date else datetime.combine(date.fromisoformat(from_date), datetime.min.time())
            params.append(parsed)
            idx += 1
        if to_date:
            col = _check_field("created_at")
            where.append(f"{col} <= ${idx}")
            parsed = datetime.fromisoformat(to_date) if "T" in to_date else datetime.combine(date.fromisoformat(to_date), datetime.max.time().replace(microsecond=0))
            params.append(parsed)
            idx += 1

        where_clause = " AND ".join(where)

        count_row = await self.conn.fetchrow(
            f"SELECT COUNT(*) AS cnt FROM {self.audit_log} WHERE {where_clause}",
            *params,
        )
        total = count_row["cnt"]

        params.extend([limit, offset])
        rows = await self.conn.fetch(
            f"""
            SELECT id, action, username, details, changelog, created_at
            FROM {self.audit_log}
            WHERE {where_clause}
            ORDER BY created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *params,
        )
        items = []
        for r in rows:
            entry = dict(r)
            details_val = entry.get("details")
            if isinstance(details_val, str):
                entry["details"] = json.loads(details_val)
            changelog_val = entry.get("changelog")
            if isinstance(changelog_val, str):
                entry["changelog"] = json.loads(changelog_val)
            elif changelog_val is None:
                entry["changelog"] = []
            items.append(entry)
        return items, total

    # -------------------------------------------------------------------------
    # CONTENT DIFF
    # -------------------------------------------------------------------------

    async def compute_content_diff(self, act_id: int, data) -> dict:
        """
        Вычисляет diff: загружает текущие ID+хеши из БД, сравнивает с входящими.

        Args:
            act_id: ID акта
            data: ActDataSchema с входящими данными

        Returns:
            dict с информацией об изменениях в tree, tables, textblocks, violations
        """
        try:
            # Один UNION ALL вместо четырёх отдельных SELECT'ов — экономит
            # 3 round-trip'а к БД на каждое сохранение содержимого. Все
            # три таблицы фильтруются по одному ``act_id``, проекция
            # унифицирована до ``(kind, id, hash)``; ``tree`` идёт пятым
            # SELECT'ом, потому что возвращает другой тип данных
            # (``tree_data`` целиком, а не пара id+hash).
            content_rows = await self.conn.fetch(
                f"""
                SELECT 'table' AS kind, table_id AS id,
                       md5(grid_data::text) AS hash
                FROM {self._tables} WHERE act_id = $1
                UNION ALL
                SELECT 'textblock' AS kind, textblock_id AS id,
                       md5(content) AS hash
                FROM {self._textblocks} WHERE act_id = $1
                UNION ALL
                SELECT 'violation' AS kind, violation_id AS id,
                       md5(COALESCE(violated::text, '') || COALESCE(established::text, '')) AS hash
                FROM {self._violations} WHERE act_id = $1
                """,
                act_id,
            )
            db_tree_row = await self.conn.fetchrow(
                f"SELECT tree_data FROM {self._tree} WHERE act_id = $1",
                act_id,
            )

            db_table_ids: dict = {}
            db_tb_ids: dict = {}
            db_viol_ids: dict = {}
            for r in content_rows:
                kind = r["kind"]
                if kind == "table":
                    db_table_ids[r["id"]] = r["hash"]
                elif kind == "textblock":
                    db_tb_ids[r["id"]] = r["hash"]
                elif kind == "violation":
                    db_viol_ids[r["id"]] = r["hash"]

            # Tables diff
            new_table_ids = set(data.tables.keys())
            old_table_ids = set(db_table_ids.keys())

            tables_added = len(new_table_ids - old_table_ids)
            tables_removed = len(old_table_ids - new_table_ids)
            tables_possibly_changed = len(new_table_ids & old_table_ids)

            # Textblocks diff
            new_tb_ids = set(data.textBlocks.keys())
            old_tb_ids = set(db_tb_ids.keys())

            # Violations diff
            new_viol_ids = set(data.violations.keys())
            old_viol_ids = set(db_viol_ids.keys())

            # Tree diff
            tree_nodes_added = 0
            tree_nodes_removed = 0
            tree_total = 0
            if db_tree_row and db_tree_row["tree_data"]:
                old_tree = db_tree_row["tree_data"]
                if isinstance(old_tree, str):
                    old_tree = json.loads(old_tree)
                old_node_ids = self._extract_node_ids(old_tree)
                new_node_ids = self._extract_node_ids(data.tree)
                tree_nodes_added = len(new_node_ids - old_node_ids)
                tree_nodes_removed = len(old_node_ids - new_node_ids)
                tree_total = len(new_node_ids)
            else:
                new_node_ids = self._extract_node_ids(data.tree)
                tree_total = len(new_node_ids)
                tree_nodes_added = tree_total

            content_map = self._build_node_content_map(data.tree)

            return {
                "tree": {
                    "nodes_added": tree_nodes_added,
                    "nodes_removed": tree_nodes_removed,
                    "total": tree_total,
                },
                "tables": {
                    "added": tables_added,
                    "removed": tables_removed,
                    "existing": tables_possibly_changed,
                    "total": len(new_table_ids),
                    "added_names": [content_map.get(tid, tid) for tid in (new_table_ids - old_table_ids)],
                    "removed_ids": list(old_table_ids - new_table_ids),
                },
                "textblocks": {
                    "added": len(new_tb_ids - old_tb_ids),
                    "removed": len(old_tb_ids - new_tb_ids),
                    "existing": len(new_tb_ids & old_tb_ids),
                    "total": len(new_tb_ids),
                    "added_names": [content_map.get(tid, tid) for tid in (new_tb_ids - old_tb_ids)],
                    "removed_ids": list(old_tb_ids - new_tb_ids),
                },
                "violations": {
                    "added": len(new_viol_ids - old_viol_ids),
                    "removed": len(old_viol_ids - new_viol_ids),
                    "existing": len(new_viol_ids & old_viol_ids),
                    "total": len(new_viol_ids),
                    "added_names": [content_map.get(vid, vid) for vid in (new_viol_ids - old_viol_ids)],
                    "removed_ids": list(old_viol_ids - new_viol_ids),
                },
            }

        except Exception:
            logger.exception(f"Не удалось вычислить diff содержимого: act_id={act_id}")
            return {"error": "diff computation failed"}

    async def compute_field_diffs(
        self,
        act_id: int,
        data,
        *,
        max_elements: int = 20,
        max_cells_per_table: int = 50,
    ) -> dict[str, dict]:
        """
        Вычисляет field-level diff для элементов, изменённых при content_save.

        Сравнивает текущее состояние в БД с входящими данными.

        Для полей-коллекций нарушения (descriptionList/additionalContent)
        в diff пишется только компактная сводка
        ``{"changed": True, "old_items": N, "new_items": M}`` — содержимое
        элементов не сохраняется, т.к. additionalContent может содержать
        base64-картинки на мегабайты.

        Args:
            act_id: ID акта
            data: ActDataSchema с входящими данными
            max_elements: Максимум элементов для diff
            max_cells_per_table: Максимум ячеек на таблицу

        Returns:
            {element_id: {type, name, ...changes}}
        """
        try:
            content_map = self._build_node_content_map(data.tree)
            result: dict[str, dict] = {}
            processed = 0

            # --- Таблицы ---
            db_tables = await self.conn.fetch(
                f"SELECT table_id, grid_data FROM {self._tables} WHERE act_id = $1",
                act_id,
            )
            db_table_map = {r["table_id"]: r["grid_data"] for r in db_tables}

            for table_id, new_table in data.tables.items():
                if processed >= max_elements:
                    break
                old_grid_raw = db_table_map.get(table_id)
                if old_grid_raw is None:
                    continue  # новая таблица — не diff
                old_grid = json.loads(old_grid_raw) if isinstance(old_grid_raw, str) else old_grid_raw
                new_grid = [
                    [cell.model_dump() for cell in row]
                    for row in new_table.grid
                ]
                cells = self._diff_table_cells(old_grid, new_grid, max_cells=max_cells_per_table)
                if cells:
                    result[table_id] = {
                        "type": "table",
                        "name": content_map.get(table_id, table_id),
                        "cells": cells[:max_cells_per_table],
                    }
                    processed += 1

            # --- Текстблоки ---
            db_tbs = await self.conn.fetch(
                f"SELECT textblock_id, content FROM {self._textblocks} WHERE act_id = $1",
                act_id,
            )
            db_tb_map = {r["textblock_id"]: r["content"] for r in db_tbs}

            for tb_id, new_tb in data.textBlocks.items():
                if processed >= max_elements:
                    break
                old_content = db_tb_map.get(tb_id)
                if old_content is None:
                    continue
                new_content = new_tb.content or ""
                if old_content != new_content:
                    result[tb_id] = {
                        "type": "textblock",
                        "name": content_map.get(tb_id, tb_id),
                        "old_length": len(old_content),
                        "new_length": len(new_content),
                    }
                    processed += 1

            # --- Нарушения ---
            # Блочная модель: все 10 полей — контейнеры {enabled, blocks};
            # SELECT и разбор строки — через маппер по реестру. В аудит-лог
            # уходит компактная сводка (факт изменения + число блоков), а не
            # содержимое: блоки могут нести base64-картинки на мегабайты.
            db_viols = await self.conn.fetch(
                f"SELECT {violation_row_mapper.select_columns_sql()} "
                f"FROM {self._violations} WHERE act_id = $1",
                act_id,
            )
            db_viol_map = {
                r["violation_id"]: violation_row_mapper.row_to_violation_dict(r)
                for r in db_viols
            }

            for viol_id, new_viol in data.violations.items():
                if processed >= max_elements:
                    break
                old = db_viol_map.get(viol_id)
                if old is None:
                    continue
                changed_fields: dict[str, dict] = {}
                for field in VIOLATION_FIELDS:
                    empty = {"enabled": field.mandatory, "blocks": []}
                    old_container = old.get(field.key) or empty
                    new_obj = getattr(new_viol, field.key, None)
                    new_container = new_obj.model_dump() if new_obj is not None else empty
                    if old_container != new_container:
                        changed_fields[field.key] = {
                            "changed": True,
                            "old_blocks": len(old_container.get("blocks") or []),
                            "new_blocks": len(new_container.get("blocks") or []),
                        }
                if (old.get("fieldOrder") or None) != (new_viol.fieldOrder or None):
                    changed_fields["fieldOrder"] = {"changed": True}
                if changed_fields:
                    result[viol_id] = {
                        "type": "violation",
                        "name": content_map.get(viol_id, viol_id),
                        "fields": changed_fields,
                    }
                    processed += 1

            return result

        except Exception:
            logger.exception(f"Не удалось вычислить field-level diff: act_id={act_id}")
            return {}

    @staticmethod
    def _diff_table_cells(old_grid: list, new_grid: list, *, max_cells: int = 50) -> list[dict]:
        """Попарное сравнение ячеек двух grid, возвращает список изменённых."""
        changes: list[dict] = []
        max_rows = max(len(old_grid), len(new_grid))
        max_cols = 0
        if old_grid:
            max_cols = max(max_cols, max(len(r) for r in old_grid))
        if new_grid:
            max_cols = max(max_cols, max(len(r) for r in new_grid))

        # Определяем имена колонок из заголовочной строки
        header_names: list[str] = []
        for grid in (old_grid, new_grid):
            if grid and grid[0]:
                for c_idx, cell in enumerate(grid[0]):
                    is_header = cell.get("isHeader", False) if isinstance(cell, dict) else False
                    if is_header and cell.get("content"):
                        while len(header_names) <= c_idx:
                            header_names.append("")
                        header_names[c_idx] = cell["content"]
                break

        for r in range(max_rows):
            for c in range(max_cols):
                old_val = ""
                new_val = ""
                if r < len(old_grid) and c < len(old_grid[r]):
                    cell = old_grid[r][c]
                    if isinstance(cell, dict) and not cell.get("isSpanned"):
                        old_val = cell.get("content", "")
                if r < len(new_grid) and c < len(new_grid[r]):
                    cell = new_grid[r][c]
                    if isinstance(cell, dict) and not cell.get("isSpanned"):
                        new_val = cell.get("content", "")
                if old_val != new_val:
                    col_name = header_names[c] if c < len(header_names) and header_names[c] else f"кол. {c + 1}"
                    changes.append({
                        "row": r,
                        "col": c,
                        "col_name": col_name,
                        "old": str(old_val)[:100],
                        "new": str(new_val)[:100],
                    })
                    if len(changes) >= max_cells:
                        return changes
        return changes

    @staticmethod
    def _build_node_content_map(tree: dict) -> dict:
        """Строит маппинг contentId -> label из дерева."""
        mapping = {}
        if not tree:
            return mapping

        def walk(node):
            if not node:
                return
            label = node.get("label", "")
            if node.get("tableId"):
                mapping[node["tableId"]] = label
            if node.get("textBlockId"):
                mapping[node["textBlockId"]] = label
            if node.get("violationId"):
                mapping[node["violationId"]] = label
            for child in node.get("children", []):
                walk(child)

        walk(tree)
        return mapping

    @staticmethod
    def _extract_node_ids(tree: dict) -> set[str]:
        """Рекурсивно извлекает все node_id из дерева."""
        ids: set[str] = set()
        if not tree:
            return ids

        node_id = tree.get("id")
        if node_id:
            ids.add(node_id)

        for child in tree.get("children", []):
            ids.update(ActAuditLogRepository._extract_node_ids(child))

        return ids
