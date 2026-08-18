"""
Репозиторий операций с содержимым актов.

Инкапсулирует SQL-запросы для загрузки и сохранения:
- Дерево структуры (act_tree)
- Таблицы (act_tables)
- Текстовые блоки (act_textblocks)
- Нарушения (act_violations)
- Синхронизация фактур и поручений
"""

import json
import logging

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.acts.block_types import LEAF_BLOCK_REFS, LEAF_BLOCK_TYPES
from app.domains.acts.repositories import violation_row_mapper
from app.domains.acts.utils import ActDirectivesValidator, ActTreeUtils
from app.domains.acts.schemas.act_content import ActDataSchema

logger = logging.getLogger("audit_workstation.db.repository.content")


class ActContentRepository(BaseRepository):
    """Операции загрузки и сохранения содержимого актов."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.acts = self.adapter.get_table_name("acts")
        self.tree = self.adapter.get_table_name("act_tree")
        self.tables = self.adapter.get_table_name("act_tables")
        self.textblocks = self.adapter.get_table_name("act_textblocks")
        self.violations = self.adapter.get_table_name("act_violations")
        self.invoices = self.adapter.get_table_name("act_invoices")
        self.directives = self.adapter.get_table_name("act_directives")

    # -------------------------------------------------------------------------
    # ПУБЛИЧНЫЕ МЕТОДЫ
    # -------------------------------------------------------------------------

    async def get_content(self, act_id: int) -> dict:
        """
        Загружает содержимое акта: дерево, таблицы, текстовые блоки, нарушения.

        Args:
            act_id: ID акта

        Returns:
            Словарь {tree, tables, textBlocks, violations}
        """
        tree = await self._load_tree(act_id)
        tables = await self._load_tables(act_id)
        text_blocks = await self._load_textblocks(act_id)
        violations = await self._load_violations(act_id)

        return {
            "tree": tree,
            "tables": tables,
            "textBlocks": text_blocks,
            "violations": violations,
        }

    async def save_content(
        self,
        act_id: int,
        data: ActDataSchema,
        username: str,
        *,
        validation_status: str = "ok",
        validation_issues: list[dict] | None = None,
    ) -> dict:
        """
        Сохраняет содержимое акта.

        Обновляет дерево, пересоздаёт таблицы/текстовые блоки/нарушения,
        синхронизирует фактуры и поручения, обновляет метку редактирования и
        состояние структурной валидации (validation_status/validation_issues,
        вычислены сервисом — фича #8).

        КОНТРАКТ: вызывается внутри УЖЕ ОТКРЫТОЙ транзакции вызывающего
        сервиса (ActContentService.save_content / AuditLogService.
        restore_version) — собственную транзакцию метод не открывает,
        чтобы не плодить savepoint'ы (вложенный conn.transaction()
        в asyncpg = SAVEPOINT, на Greenplum вложенность не используем).

        Args:
            act_id: ID акта
            data: Валидированные данные акта
            username: Имя пользователя

        Returns:
            Словарь {status, message}
        """
        # Получаем audit_act_id из таблицы acts
        audit_act_id = await self.conn.fetchval(
            f"SELECT audit_act_id FROM {self.acts} WHERE id = $1",
            act_id
        )

        # Маппинг {node_id -> audit_point_id} обходом дерева
        audit_point_map = ActDirectivesValidator.build_audit_point_map(data.tree)

        # Маппинг {node_id -> {number, label, parent_item_node_id}} за один обход
        node_map = self._build_node_map(data.tree)
        # Рефереры по id записи (находка #21 + лечение устаревшего nodeId,
        # см. _build_referrers) — отдельная структура, node_map ей не
        # расширяем (горячий путь сохранения).
        referrers = self._build_referrers(data.tree)

        await self._save_tree(act_id, data.tree)
        dropped_tables = await self._save_tables(
            act_id, audit_act_id, data, audit_point_map, node_map, referrers["tables"]
        )
        dropped_textblocks = await self._save_textblocks(
            act_id, audit_act_id, data, audit_point_map, node_map, referrers["textBlocks"]
        )
        dropped_violations = await self._save_violations(
            act_id, audit_act_id, data, audit_point_map, node_map, referrers["violations"]
        )
        await self._sync_invoices(act_id, audit_act_id, data, audit_point_map)
        await self._sync_directives(act_id, audit_act_id, data, audit_point_map)
        stamp = await self._update_edit_timestamp(
            act_id, username,
            validation_status=validation_status,
            validation_issues=validation_issues or [],
        )

        logger.info(f"Сохранено содержимое акта ID={act_id} пользователем {username}")

        # updated_at отдаётся фронту: он запоминает его как базу метаданных
        # снимка-черновика localStorage (baseUpdatedAt) для решения о
        # восстановлении черновика при следующей загрузке акта.
        # content_version — свежий счётчик версий содержимого: фронт эхом
        # возвращает его в expected_content_version следующего PUT
        # (optimistic-проверка конкурентного редактирования).
        # dropped_orphans — суммарное число записей словарей, отброшенных
        # orphan-фильтром (нет узла-владельца в дереве); сервис включает его
        # в warning пользователю.
        return {
            "status": "success",
            "message": "Содержимое акта сохранено",
            "updated_at": stamp["updated_at"] if stamp else None,
            "content_version": stamp["content_version"] if stamp else None,
            "dropped_orphans": dropped_tables + dropped_textblocks + dropped_violations,
        }

    # -------------------------------------------------------------------------
    # ЗАГРУЗКА
    # -------------------------------------------------------------------------

    async def _load_tree(self, act_id: int) -> dict:
        """Загружает дерево структуры акта."""
        row = await self.conn.fetchrow(
            f"SELECT tree_data FROM {self.tree} WHERE act_id = $1",
            act_id
        )
        if row:
            return json.loads(row['tree_data'])
        return {"id": "root", "label": "Акт", "children": []}

    async def _load_tables(self, act_id: int) -> dict[str, dict]:
        """Загружает таблицы акта."""
        rows = await self.conn.fetch(
            f"""
            SELECT table_id, node_id, grid_data, col_widths, is_protected,
                   is_deletable, kind
            FROM {self.tables}
            WHERE act_id = $1
            """,
            act_id
        )
        return {
            row['table_id']: {
                'id': row['table_id'],
                'nodeId': row['node_id'],
                'grid': json.loads(row['grid_data']),
                'colWidths': json.loads(row['col_widths']),
                'protected': row['is_protected'],
                'deletable': row['is_deletable'],
                'kind': row['kind']
            }
            for row in rows
        }

    async def _load_textblocks(self, act_id: int) -> dict[str, dict]:
        """Загружает текстовые блоки акта."""
        rows = await self.conn.fetch(
            f"""
            SELECT textblock_id, node_id, content
            FROM {self.textblocks}
            WHERE act_id = $1
            """,
            act_id
        )
        return {
            row['textblock_id']: {
                'id': row['textblock_id'],
                'nodeId': row['node_id'],
                'content': row['content'],
            }
            for row in rows
        }

    async def _load_violations(self, act_id: int) -> dict[str, dict]:
        """Загружает нарушения акта (разбор строки — маппер по реестру полей)."""
        rows = await self.conn.fetch(
            f"""
            SELECT {violation_row_mapper.select_columns_sql()}
            FROM {self.violations}
            WHERE act_id = $1
            """,
            act_id
        )
        return {
            row['violation_id']: violation_row_mapper.row_to_violation_dict(row)
            for row in rows
        }

    # -------------------------------------------------------------------------
    # СОХРАНЕНИЕ
    # -------------------------------------------------------------------------

    @staticmethod
    def _build_node_map(tree: dict) -> dict[str, dict]:
        """
        Один обход дерева — собирает number, label и parent_item_node_id для каждого узла.

        Returns:
            Маппинг {node_id: {"number": str | None, "label": str | None,
                               "parent_item_node_id": str | None}}
        """
        node_map: dict[str, dict] = {}
        # Элементы стека: (node, parent_item_id)
        stack: list[tuple[dict, str | None]] = [(tree, None)]

        while stack:
            node, parent_item_id = stack.pop()
            node_id = node.get("id")
            node_type = node.get("type", "item")

            # Определяем current_item_id по логике find_parent_item_node_id
            if node_type == "item" or node_type not in LEAF_BLOCK_TYPES:
                current_item_id = node_id
            else:
                current_item_id = parent_item_id

            # Для content-узлов parent_item_node_id = parent_item_id,
            # для item-узлов = собственный id
            if node_type in LEAF_BLOCK_TYPES:
                resolved_parent = parent_item_id
            else:
                resolved_parent = node_id

            if node_id:
                node_map[node_id] = {
                    "number": node.get("number"),
                    "label": node.get("label"),
                    "parent_item_node_id": resolved_parent,
                }

            for child in node.get("children", []):
                stack.append((child, current_item_id))

        return node_map

    @staticmethod
    def _build_referrers(tree: dict) -> dict[str, dict[str, list[str]]]:
        """
        Обратный индекс (находка #21, Вариант Б; расширен под лечение
        устаревшего nodeId — «restore теряет таблицу»): для каждого словаря
        (tables/textBlocks/violations) — {entry_id: [node_id, ...]}, узлы
        дерева, чьё поле-ссылка (tableId/textBlockId/violationId) реально
        указывает на entry_id, В ДОКУМЕНТНОМ ПОРЯДКЕ (родитель раньше детей,
        дети — в естественном порядке).

        orphan-фильтр раньше проверял лишь существование узла с nodeId
        записи (_build_node_map/node_map) — этого недостаточно: запись
        могла указывать на существующий узел, который в реальности
        ссылается на ДРУГУЮ запись словаря (такой фантом переживал старый
        фильтр), либо на узел, которого вовсе нет в дереве (мёртвый
        nodeId) — тогда запись дропалась ДАЖЕ если другой живой узел на неё
        реально ссылался (путь restore_version мимо фронтового санитайзера
        терял таблицу/нарушение целиком). Список рефереров вместо простого
        множества нужен для лечения: если entry.nodeId не входит в список,
        запись не дропается, а получает первого реферера — см.
        _resolve_owner_node_id.

        Returns:
            {dictName: {entry_id: [node_id, ...]}} — по одному словарю на
            словарь контента.
        """
        referrers: dict[str, dict[str, list[str]]] = {
            dict_name: {} for _, dict_name in LEAF_BLOCK_REFS.values()
        }
        stack: list[dict] = [tree]

        while stack:
            node = stack.pop()
            node_id = node.get("id")
            if node_id:
                for ref_field, dict_name in LEAF_BLOCK_REFS.values():
                    ref = node.get(ref_field)
                    if ref:
                        referrers[dict_name].setdefault(ref, []).append(node_id)
            # reversed(): LIFO-стек с детьми, добавленными в обратном порядке,
            # отдаёт их через pop() в естественном порядке — обязательно для
            # документного порядка рефереров (см. docstring/Returns).
            for child in reversed(node.get("children", [])):
                stack.append(child)

        return referrers

    @staticmethod
    def _resolve_owner_node_id(
        entry_id: str, node_id: str, referrers: dict[str, list[str]]
    ) -> str | None:
        """
        Определяет владельца записи словаря по (де)нормализованному nodeId.

        Returns:
            None — запись сирота (ни один узел дерева не ссылается на
            entry_id), вызывающий код её дропает. Иначе — валидный node_id
            владельца: сам entry.nodeId, если он входит в список рефереров
            (валидная ссылка, не переписывается), либо первый реферер в
            документном порядке — денормализованный nodeId ЛЕЧИТСЯ по
            актуальной ссылке дерева вместо того, чтобы запись отбрасывалась
            целиком.
        """
        refs = referrers.get(entry_id)
        if not refs:
            return None
        return node_id if node_id in refs else refs[0]

    async def _save_tree(self, act_id: int, tree: dict) -> None:
        """Обновляет дерево структуры акта."""
        await self.conn.execute(
            f"""
            UPDATE {self.tree}
            SET tree_data = $1, updated_at = CURRENT_TIMESTAMP
            WHERE act_id = $2
            """,
            json.dumps(tree),
            act_id
        )

    async def _save_tables(
        self, act_id: int, audit_act_id: str | None,
        data: ActDataSchema, audit_point_map: dict,
        node_map: dict[str, dict], referrers: dict[str, list[str]]
    ) -> int:
        """Пересоздаёт таблицы акта (batch INSERT через executemany).

        Returns:
            Число таблиц-сирот (ни один узел дерева реально не ссылается на
            table_id — находка #21), отброшенных orphan-фильтром — сервис
            агрегирует это в warning пользователю. Таблица с устаревшим/
            несуществующим nodeId, на которую при этом реально ссылается
            живой узел, сиротой НЕ считается — её nodeId лечится на
            актуального реферера (_resolve_owner_node_id); раньше такую
            запись дропало восстановление версии («restore теряет таблицу»).
        """
        await self.conn.execute(
            f"DELETE FROM {self.tables} WHERE act_id = $1",
            act_id
        )

        args: list[tuple] = []
        dropped = 0
        for table_id, table_data in data.tables.items():
            owner_node_id = self._resolve_owner_node_id(table_id, table_data.nodeId, referrers)
            # Orphan-фильтр: ни один узел дерева реально не ссылается на
            # table_id (находка #21, обратная сверка) — не пишется (иначе в
            # act_tables копятся записи без узла-владельца или фантомы с
            # чужим tableId).
            if owner_node_id is None:
                dropped += 1
                continue
            info = node_map.get(owner_node_id, {})
            parent_node_id = info.get("parent_item_node_id")
            audit_point_id = audit_point_map.get(parent_node_id) if parent_node_id else None

            args.append((
                act_id,
                audit_act_id,
                audit_point_id,
                table_id,
                owner_node_id,
                info.get("number"),
                info.get("label"),
                json.dumps([
                    [cell.model_dump() for cell in row]
                    for row in table_data.grid
                ]),
                json.dumps(table_data.colWidths),
                table_data.protected,
                table_data.deletable,
                getattr(table_data, 'kind', 'regular') or 'regular',
            ))

        if dropped:
            logger.warning(
                "Пропущено %d таблиц(ы) без узла-владельца в дереве (act_id=%s)",
                dropped, act_id,
            )

        if args:
            await self.conn.executemany(
                f"""
                INSERT INTO {self.tables} (
                    act_id, audit_act_id, audit_point_id,
                    table_id, node_id, node_number, table_label,
                    grid_data, col_widths, is_protected, is_deletable,
                    kind
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                """,
                args,
            )

        return dropped

    async def _save_textblocks(
        self, act_id: int, audit_act_id: str | None,
        data: ActDataSchema, audit_point_map: dict,
        node_map: dict[str, dict], referrers: dict[str, list[str]]
    ) -> int:
        """Пересоздаёт текстовые блоки акта (batch INSERT через executemany).

        Returns:
            Число текстблоков-сирот, отброшенных orphan-фильтром (в т.ч. по
            обратной сверке — находка #21). Текстблок с устаревшим nodeId, на
            который при этом реально ссылается живой узел, — не сирота, его
            nodeId лечится (_resolve_owner_node_id, единообразно с
            _save_tables).
        """
        await self.conn.execute(
            f"DELETE FROM {self.textblocks} WHERE act_id = $1",
            act_id
        )

        args: list[tuple] = []
        dropped = 0
        for tb_id, tb_data in data.textBlocks.items():
            owner_node_id = self._resolve_owner_node_id(tb_id, tb_data.nodeId, referrers)
            # Orphan-фильтр: без обратной ссылки узла (находка #21) не
            # пишется (единообразно с _save_tables, см. pbe-4).
            if owner_node_id is None:
                dropped += 1
                continue
            info = node_map.get(owner_node_id, {})
            parent_node_id = info.get("parent_item_node_id")
            audit_point_id = audit_point_map.get(parent_node_id) if parent_node_id else None

            args.append((
                act_id,
                audit_act_id,
                audit_point_id,
                tb_id,
                owner_node_id,
                info.get("number"),
                tb_data.content,
            ))

        if dropped:
            logger.warning(
                "Пропущено %d текстблок(ов) без узла-владельца в дереве (act_id=%s)",
                dropped, act_id,
            )

        if args:
            await self.conn.executemany(
                f"""
                INSERT INTO {self.textblocks} (
                    act_id, audit_act_id, audit_point_id,
                    textblock_id, node_id, node_number, content
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                """,
                args,
            )

        return dropped

    async def _save_violations(
        self, act_id: int, audit_act_id: str | None,
        data: ActDataSchema, audit_point_map: dict,
        node_map: dict[str, dict], referrers: dict[str, list[str]]
    ) -> int:
        """Пересоздаёт нарушения акта (batch INSERT через executemany).

        Returns:
            Число нарушений-сирот, отброшенных orphan-фильтром (в т.ч. по
            обратной сверке — находка #21). Нарушение с устаревшим nodeId, на
            которое при этом реально ссылается живой узел, — не сирота, его
            nodeId лечится (_resolve_owner_node_id, единообразно с
            _save_tables).
        """
        await self.conn.execute(
            f"DELETE FROM {self.violations} WHERE act_id = $1",
            act_id
        )

        args: list[tuple] = []
        dropped = 0
        for v_id, v_data in data.violations.items():
            owner_node_id = self._resolve_owner_node_id(v_id, v_data.nodeId, referrers)
            # Orphan-фильтр: без обратной ссылки узла (находка #21) не
            # пишется (единообразно с _save_tables, см. pbe-4).
            if owner_node_id is None:
                dropped += 1
                continue
            info = node_map.get(owner_node_id, {})
            parent_node_id = info.get("parent_item_node_id")
            audit_point_id = audit_point_map.get(parent_node_id) if parent_node_id else None

            args.append(violation_row_mapper.violation_insert_args(
                act_id,
                audit_act_id,
                audit_point_id,
                v_id,
                owner_node_id,
                info.get("number"),
                v_data,
            ))

        if dropped:
            logger.warning(
                "Пропущено %d нарушение(й) без узла-владельца в дереве (act_id=%s)",
                dropped, act_id,
            )

        if args:
            await self.conn.executemany(
                violation_row_mapper.insert_sql(self.violations),
                args,
            )

        return dropped

    async def _sync_invoices(
        self, act_id: int, audit_act_id: str | None,
        data: ActDataSchema, audit_point_map: dict
    ) -> None:
        """Синхронизирует фактуры: удаляет записи для узлов без фактур."""
        if data.invoiceNodeIds:
            # Удаляем фактуры для узлов, которых нет в списке
            await self.conn.execute(
                f"""
                DELETE FROM {self.invoices}
                WHERE act_id = $1
                  AND node_id != ALL($2::varchar[])
                """,
                act_id,
                data.invoiceNodeIds,
            )

            # Обновляем node_number, audit_act_id, audit_point_id для оставшихся
            for nid in data.invoiceNodeIds:
                node_number = ActTreeUtils.extract_node_number(data.tree, nid)
                inv_audit_point_id = audit_point_map.get(nid)
                await self.conn.execute(
                    f"""
                    UPDATE {self.invoices}
                    SET node_number = COALESCE($1, node_number),
                        audit_act_id = $4,
                        audit_point_id = $5,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE act_id = $2 AND node_id = $3
                    """,
                    node_number, act_id, nid,
                    audit_act_id, inv_audit_point_id,
                )
        else:
            # Список пуст — удаляем все фактуры акта
            await self.conn.execute(
                f"DELETE FROM {self.invoices} WHERE act_id = $1",
                act_id,
            )

    async def _sync_directives(
        self, act_id: int, audit_act_id: str | None,
        data: ActDataSchema, audit_point_map: dict
    ) -> None:
        """Синхронизирует поручения: обновляет point_number по node_id."""
        directives_with_node = await self.conn.fetch(
            f"""
            SELECT id, node_id, point_number
            FROM {self.directives}
            WHERE act_id = $1 AND node_id IS NOT NULL
            """,
            act_id,
        )

        for dir_row in directives_with_node:
            new_number = ActTreeUtils.extract_node_number(data.tree, dir_row["node_id"])
            dir_audit_point_id = audit_point_map.get(dir_row["node_id"])
            if new_number and new_number != dir_row["point_number"]:
                await self.conn.execute(
                    f"""
                    UPDATE {self.directives}
                    SET point_number = $1,
                        audit_act_id = $3,
                        audit_point_id = $4
                    WHERE id = $2
                    """,
                    new_number, dir_row["id"],
                    audit_act_id, dir_audit_point_id,
                )
            else:
                await self.conn.execute(
                    f"""
                    UPDATE {self.directives}
                    SET audit_act_id = $2,
                        audit_point_id = $3
                    WHERE id = $1
                    """,
                    dir_row["id"],
                    audit_act_id, dir_audit_point_id,
                )

    # -------------------------------------------------------------------------
    # ПЕРЕСТРУКТУРИЗАЦИЯ ДЕРЕВА (вызывается из ActCrudService._apply_tree_restructure)
    # -------------------------------------------------------------------------

    async def delete_nodes_content(
        self,
        act_id: int,
        *,
        table_ids: list[str] | None = None,
        textblock_ids: list[str] | None = None,
        violation_ids: list[str] | None = None,
    ) -> None:
        """Массово удаляет таблицы / текстовые блоки / нарушения по их id.

        Используется при перестройке разделов 1-2 (смена типа проверки):
        контент удаляемых узлов вычищается из соответствующих таблиц.
        Пустые списки игнорируются — лишних DELETE'ов не делаем.
        """
        if table_ids:
            await self.conn.execute(
                f"DELETE FROM {self.tables} "
                f"WHERE act_id = $1 AND table_id = ANY($2::varchar[])",
                act_id, table_ids,
            )
        if textblock_ids:
            await self.conn.execute(
                f"DELETE FROM {self.textblocks} "
                f"WHERE act_id = $1 AND textblock_id = ANY($2::varchar[])",
                act_id, textblock_ids,
            )
        if violation_ids:
            await self.conn.execute(
                f"DELETE FROM {self.violations} "
                f"WHERE act_id = $1 AND violation_id = ANY($2::varchar[])",
                act_id, violation_ids,
            )

    async def insert_table(
        self,
        act_id: int,
        *,
        table_id: str,
        node_id: str,
        grid_data: list | dict,
        col_widths: list | dict,
        is_protected: bool,
        is_deletable: bool,
        node_number: str | None = None,
        table_label: str | None = None,
        kind: str = "regular",
    ) -> None:
        """Вставляет одну системную таблицу (qualityAssessment и т.п.).

        Используется при перестройке разделов 1-2: при переходе на процессный
        тип проверки добавляются специальные таблицы оценки качества.

        Заполняет денормализацию (node_number/table_label) и подвид kind —
        чтобы вставленная системная таблица была согласована с теми,
        что пишет _save_tables, и не теряла классификацию.
        """
        await self.conn.execute(
            f"""
            INSERT INTO {self.tables}
                (act_id, table_id, node_id, node_number, table_label,
                 grid_data, col_widths, is_protected, is_deletable,
                 kind)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            """,
            act_id,
            table_id,
            node_id,
            node_number,
            table_label,
            json.dumps(grid_data),
            json.dumps(col_widths),
            is_protected,
            is_deletable,
            kind,
        )

    async def _update_edit_timestamp(
        self,
        act_id: int,
        username: str,
        *,
        validation_status: str = "ok",
        validation_issues: list[dict] | None = None,
    ):
        """Обновляет метку редактирования и состояние валидации акта.

        Единственная точка инкремента content_version — счётчика версий
        СОДЕРЖИМОГО для optimistic-проверки PUT /content. Правки метаданных
        и update_total_parts_for_km бампят только updated_at и счётчик не
        трогают — поэтому НЕ-контентные записи не дают ложных 409.

        Возвращает фактические updated_at и content_version отдельным SELECT
        (не UPDATE ... RETURNING — для совместимости с Greenplum).
        """
        await self.conn.execute(
            f"""
            UPDATE {self.acts}
            SET last_edited_by = $1,
                last_edited_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP,
                content_version = content_version + 1,
                validation_status = $3,
                validation_issues = $4::jsonb
            WHERE id = $2
            """,
            username,
            act_id,
            validation_status,
            json.dumps(validation_issues or [], ensure_ascii=False),
        )
        return await self.conn.fetchrow(
            f"SELECT updated_at, content_version FROM {self.acts} WHERE id = $1",
            act_id
        )
