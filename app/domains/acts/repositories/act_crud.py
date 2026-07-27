"""
Репозиторий CRUD операций с актами.
"""

import json
import logging

import asyncpg

from app.domains.acts.exceptions import ActNotFoundError, ActValidationError
from app.db.repositories.base import BaseRepository
from app.db.utils.json_db_utils import JSONDBUtils
from app.domains.acts.utils import KMUtils, ActDirectivesValidator
from app.domains.acts.schemas.act_metadata import (
    ActAttentionItem,
    ActListItem,
    ActResponse,
    AuditTeamMember,
    ActDirective,
)

logger = logging.getLogger("audit_workstation.db.repository.crud")


def _parse_validation_issues(value) -> list[dict] | None:
    """JSONB validation_issues → list[dict]. asyncpg может вернуть str/None."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return None
    return value


class ActCrudRepository(BaseRepository):
    """CRUD операции с актами и их связанными сущностями."""

    def __init__(self, conn: asyncpg.Connection):
        super().__init__(conn)
        self.acts = self.adapter.get_table_name("acts")
        self.audit_team = self.adapter.get_table_name("audit_team_members")
        self.directives = self.adapter.get_table_name("act_directives")
        self.tree = self.adapter.get_table_name("act_tree")
        self.tables = self.adapter.get_table_name("act_tables")
        self.textblocks = self.adapter.get_table_name("act_textblocks")
        self.violations = self.adapter.get_table_name("act_violations")

    # -------------------------------------------------------------------------
    # ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
    # -------------------------------------------------------------------------

    async def check_km_exists(self, km_number: str) -> dict:
        """
        Проверяет существование актов с данным КМ номером.

        Returns:
            Словарь с информацией:
            - exists: bool
            - total_parts: int
            - current_parts: int (backward compat)
            - next_part_no_sn: int
            - has_service_notes: bool
        """
        km_digit = KMUtils.extract_km_digits(km_number)

        row = await self.conn.fetchrow(
            f"""
            SELECT
                COUNT(*) as total_count,
                MAX(
                    CASE
                        WHEN service_note IS NULL THEN part_number
                        ELSE 0
                    END
                ) as max_part_no_sn,
                COUNT(
                    CASE
                        WHEN service_note IS NOT NULL THEN 1
                    END
                ) as with_service_notes
            FROM {self.acts}
            WHERE km_number_digit = $1
            """,
            km_digit,
        )

        total_count = row["total_count"] or 0
        exists = total_count > 0
        has_service_notes = row["with_service_notes"] > 0

        max_part_no_sn = row["max_part_no_sn"] or 0
        next_part_no_sn = max_part_no_sn + 1 if max_part_no_sn > 0 else 1

        return {
            "exists": exists,
            "total_parts": total_count,
            "current_parts": total_count,
            "next_part_no_sn": next_part_no_sn,
            "next_part": next_part_no_sn,
            "has_service_notes": has_service_notes,
        }

    async def check_km_part_uniqueness(
            self,
            km_digit: int,
            part_number: int,
            exclude_act_id: int | None = None
    ) -> bool:
        """
        Проверяет уникальность пары (km_number_digit, part_number).

        Returns:
            True если пара уникальна, False если уже существует
        """
        exists = await self.conn.fetchval(
            f"""
            SELECT EXISTS(
                SELECT 1 FROM {self.acts}
                WHERE km_number_digit = $1
                  AND part_number = $2
                  AND ($3::int IS NULL OR id != $3)
            )
            """,
            km_digit,
            part_number,
            exclude_act_id,
        )

        return not exists

    async def update_total_parts_for_km(self, km_digit: int) -> None:
        """Обновляет total_parts для всех актов с данным КМ номером."""
        total_count = await self.conn.fetchval(
            f"""
            SELECT COUNT(*)
            FROM {self.acts}
            WHERE km_number_digit = $1
            """,
            km_digit,
        )

        await self.conn.execute(
            f"""
            UPDATE {self.acts}
            SET total_parts = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE km_number_digit = $2
            """,
            total_count,
            km_digit,
        )

        logger.debug(
            f"Обновлено total_parts={total_count} для всех актов КМ (цифры)={km_digit}"
        )

    async def find_free_part_number(
            self,
            km_digit: int,
            exclude_act_id: int | None = None,
    ) -> int:
        """Находит первый свободный номер части для актов."""
        if exclude_act_id:
            rows = await self.conn.fetch(
                f"""
                SELECT part_number
                FROM {self.acts}
                WHERE km_number_digit = $1
                  AND id != $2
                ORDER BY part_number
                """,
                km_digit,
                exclude_act_id,
            )
        else:
            rows = await self.conn.fetch(
                f"""
                SELECT part_number
                FROM {self.acts}
                WHERE km_number_digit = $1
                ORDER BY part_number
                """,
                km_digit,
            )

        occupied_numbers = {row["part_number"] for row in rows}

        part_number = 1
        while part_number in occupied_numbers:
            part_number += 1

        logger.debug(
            f"Найден свободный номер части {part_number} для КМ (цифры)={km_digit}. "
            f"Занятые номера: {sorted(occupied_numbers)}"
        )

        return part_number

    async def validate_directives_points(
            self,
            act_id: int,
            directives: list[ActDirective],
    ) -> dict | None:
        """Проверяет что все пункты поручений существуют в структуре акта."""
        if not directives:
            return None

        tree_row = await self.conn.fetchrow(
            f"SELECT tree_data FROM {self.tree} WHERE act_id = $1",
            act_id,
        )

        if not tree_row:
            raise ActNotFoundError("Структура акта не найдена")

        tree_data = JSONDBUtils.ensure_dict(tree_row["tree_data"])
        if tree_data is None:
            raise ActValidationError("Структура акта имеет некорректный формат (ожидался JSON-объект)")

        existing_points = ActDirectivesValidator.collect_node_numbers(tree_data)
        ActDirectivesValidator.validate_directives_points(
            directives,
            existing_points,
        )

        return tree_data

    # -------------------------------------------------------------------------
    # АТОМАРНЫЕ ОПЕРАЦИИ ЗАПИСИ
    # -------------------------------------------------------------------------

    async def insert_act(
        self,
        *,
        km_number: str,
        km_digit: int,
        part_number: int,
        total_parts: int,
        inspection_name: str | None,
        city: str | None,
        created_date: str | None,
        order_number: str | None,
        order_date: str | None,
        is_process_based: bool,
        service_note: str | None,
        service_note_date: str | None,
        audit_act_id: str,
        created_by: str,
        inspection_start_date: str | None,
        inspection_end_date: str | None,
    ) -> int:
        """INSERT INTO acts RETURNING id."""
        return await self.conn.fetchval(
            f"""
            INSERT INTO {self.acts} (
                km_number, km_number_digit, part_number, total_parts,
                inspection_name, city, created_date,
                order_number, order_date, is_process_based,
                service_note, service_note_date,
                audit_act_id,
                created_by, inspection_start_date, inspection_end_date,
                last_edited_at
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10,
                $11, $12,
                $13,
                $14, $15, $16,
                CURRENT_TIMESTAMP
            )
            RETURNING id
            """,
            km_number, km_digit, part_number, total_parts,
            inspection_name, city, created_date,
            order_number, order_date, is_process_based,
            service_note, service_note_date,
            audit_act_id,
            created_by, inspection_start_date, inspection_end_date,
        )

    async def insert_team_members_batch(
        self, act_id: int, audit_act_id: str, members: list,
    ) -> None:
        """Batch INSERT участников аудиторской группы."""
        if not members:
            return
        await self.conn.executemany(
            f"""
            INSERT INTO {self.audit_team} (
                act_id, audit_act_id, role, full_name, position, username, order_index
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            [
                (act_id, audit_act_id,
                 m.role, m.full_name, m.position, m.username, idx)
                for idx, m in enumerate(members)
            ],
        )

    async def insert_directives_batch(
        self,
        act_id: int,
        audit_act_id: str,
        directives: list,
        audit_point_map: dict | None = None,
    ) -> None:
        """Batch INSERT поручений."""
        if not directives:
            return
        await self.conn.executemany(
            f"""
            INSERT INTO {self.directives} (
                act_id, audit_act_id, audit_point_id,
                point_number, node_id, directive_number, order_index
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            [
                (act_id, audit_act_id,
                 (audit_point_map.get(d.node_id) if audit_point_map and d.node_id else None),
                 d.point_number, d.node_id, d.directive_number, idx)
                for idx, d in enumerate(directives)
            ],
        )

    async def insert_default_tree(self, act_id: int, tree_data: dict) -> None:
        """INSERT дерева для нового акта."""
        await self.conn.execute(
            f"""
            INSERT INTO {self.tree} (act_id, tree_data)
            VALUES ($1, $2)
            """,
            act_id,
            json.dumps(tree_data),
        )

    async def replace_team_members(
        self, act_id: int, audit_act_id: str, members: list,
    ) -> None:
        """DELETE + batch INSERT участников аудиторской группы."""
        await self.conn.execute(
            f"DELETE FROM {self.audit_team} WHERE act_id = $1",
            act_id,
        )
        await self.insert_team_members_batch(act_id, audit_act_id, members)

    async def replace_directives(
        self,
        act_id: int,
        audit_act_id: str,
        directives: list,
        audit_point_map: dict | None = None,
    ) -> None:
        """DELETE + batch INSERT поручений."""
        await self.conn.execute(
            f"DELETE FROM {self.directives} WHERE act_id = $1",
            act_id,
        )
        await self.insert_directives_batch(
            act_id, audit_act_id, directives, audit_point_map
        )

    async def copy_tree(self, from_id: int, to_id: int) -> None:
        """Копирует дерево из одного акта в другой (INSERT или UPDATE)."""
        existing = await self.conn.fetchval(
            f"SELECT 1 FROM {self.tree} WHERE act_id = $1",
            to_id,
        )
        if existing:
            await self.conn.execute(
                f"""
                UPDATE {self.tree}
                SET tree_data = src.tree_data,
                    updated_at = CURRENT_TIMESTAMP
                FROM (SELECT tree_data FROM {self.tree} WHERE act_id = $1) src
                WHERE {self.tree}.act_id = $2
                """,
                from_id,
                to_id,
            )
        else:
            await self.conn.execute(
                f"""
                INSERT INTO {self.tree} (act_id, tree_data)
                SELECT $2, tree_data
                FROM {self.tree}
                WHERE act_id = $1
                """,
                from_id,
                to_id,
            )

    async def copy_tables(self, from_id: int, to_id: int) -> None:
        """Копирует таблицы из одного акта в другой (1 запрос).

        Копирует подвид таблицы (kind) — иначе у дубликата спецтаблицы
        (риск/налоговые/прочие/сводные) деградируют до обычных.
        """
        await self.conn.execute(
            f"""
            INSERT INTO {self.tables} (
                act_id, table_id, node_id, node_number, table_label,
                grid_data, col_widths, is_protected, is_deletable,
                kind
            )
            SELECT
                $2, table_id, node_id, node_number, table_label,
                grid_data, col_widths, is_protected, is_deletable,
                kind
            FROM {self.tables}
            WHERE act_id = $1
            """,
            from_id,
            to_id,
        )

    async def copy_textblocks(self, from_id: int, to_id: int) -> None:
        """Копирует текстовые блоки из одного акта в другой (1 запрос)."""
        await self.conn.execute(
            f"""
            INSERT INTO {self.textblocks} (
                act_id, textblock_id, node_id, node_number, content
            )
            SELECT
                $2, textblock_id, node_id, node_number, content
            FROM {self.textblocks}
            WHERE act_id = $1
            """,
            from_id,
            to_id,
        )

    async def copy_violations(self, from_id: int, to_id: int) -> None:
        """Копирует нарушения из одного акта в другой (1 запрос)."""
        await self.conn.execute(
            f"""
            INSERT INTO {self.violations} (
                act_id, violation_id, node_id, node_number, violated, established,
                description_list, additional_content, reasons, consequences,
                responsible, measures
            )
            SELECT
                $2, violation_id, node_id, node_number, violated, established,
                description_list, additional_content, reasons, consequences,
                responsible, measures
            FROM {self.violations}
            WHERE act_id = $1
            """,
            from_id,
            to_id,
        )

    # -------------------------------------------------------------------------
    # ЧТЕНИЕ
    # -------------------------------------------------------------------------

    async def count_user_acts(self, username: str) -> int:
        """Считает количество актов, где пользователь является участником."""
        return await self.conn.fetchval(
            f"""
            SELECT COUNT(DISTINCT a.id)
            FROM {self.acts} a
            INNER JOIN {self.audit_team} atm ON a.id = atm.act_id
            WHERE atm.username = $1
            """,
            username,
        )

    async def count_all_acts(self) -> int:
        """Считает общее количество актов в системе (для админ-просмотра)."""
        return await self.conn.fetchval(f"SELECT COUNT(*) FROM {self.acts}")

    async def get_user_acts(
        self,
        username: str,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> list[ActListItem]:
        """Получает список актов, где пользователь является участником."""
        rows = await self.conn.fetch(
            f"""
            SELECT
                a.id,
                a.km_number,
                a.part_number,
                a.total_parts,
                a.inspection_name,
                a.order_number,
                a.inspection_start_date,
                a.inspection_end_date,
                a.last_edited_at,
                a.created_at,
                a.service_note,
                a.audit_act_id,
                MIN(atm.role) as user_role,
                a.locked_by,
                (a.locked_by IS NOT NULL
                 AND a.lock_expires_at IS NOT NULL
                 AND a.lock_expires_at > CURRENT_TIMESTAMP) as is_locked,
                a.needs_created_date,
                a.needs_directive_number,
                a.needs_invoice_check,
                a.needs_service_note,
                a.validation_status,
                a.validation_issues
            FROM {self.acts} a
            INNER JOIN {self.audit_team} atm ON a.id = atm.act_id
            WHERE atm.username = $1
            GROUP BY
                a.id,
                a.km_number,
                a.part_number,
                a.total_parts,
                a.inspection_name,
                a.order_number,
                a.inspection_start_date,
                a.inspection_end_date,
                a.last_edited_at,
                a.created_at,
                a.service_note,
                a.audit_act_id,
                a.locked_by,
                a.lock_expires_at,
                a.needs_created_date,
                a.needs_directive_number,
                a.needs_invoice_check,
                a.needs_service_note,
                a.validation_status,
                a.validation_issues
            ORDER BY
                COALESCE(a.last_edited_at, a.created_at) DESC,
                a.created_at DESC
            LIMIT $2 OFFSET $3
            """,
            username,
            limit,
            offset,
        )

        return [
            self._build_act_list_item(row)
            for row in rows
        ]

    @staticmethod
    def _build_act_list_item(row) -> ActListItem:
        """Собирает ActListItem из строки запроса (общий хелпер).

        Выделен чтобы не дублировать маппинг полей между ``get_user_acts``
        (для участников команды) и ``get_all_acts_as_admin`` (для админа,
        видящего все акты).
        """
        return ActListItem(
            id=row["id"],
            km_number=row["km_number"],
            part_number=row["part_number"],
            total_parts=row["total_parts"],
            inspection_name=row["inspection_name"],
            order_number=row["order_number"],
            inspection_start_date=row["inspection_start_date"],
            inspection_end_date=row["inspection_end_date"],
            last_edited_at=row["last_edited_at"],
            user_role=row["user_role"],
            service_note=row["service_note"],
            audit_act_id=row["audit_act_id"],
            locked_by=row["locked_by"],
            is_locked=row["is_locked"],
            needs_created_date=row["needs_created_date"],
            needs_directive_number=row["needs_directive_number"],
            needs_invoice_check=row["needs_invoice_check"],
            needs_service_note=row["needs_service_note"],
            validation_status=row["validation_status"],
            validation_issues=_parse_validation_issues(row["validation_issues"]),
        )

    async def get_all_acts_as_admin(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> list[ActListItem]:
        """Получает ВСЕ акты в системе (только для администраторов).

        Используется на странице «Управление актами» — админ видит не только
        акты, в команде которых он состоит, но и акты, созданные другими
        пользователями. Чтобы отличить «системный» доступ от «командного»,
        роль пользователя в таких актах подменяется на «Администратор»:
        в ``audit_team_members`` такой роли быть НЕ должно (это системная роль,
        а не роль в рамках проверки — см. ТЗ заказчика). Поэтому возвращаем
        «Администратор» как литерал здесь, не джойнясь с team.
        """
        rows = await self.conn.fetch(
            f"""
            SELECT
                a.id,
                a.km_number,
                a.part_number,
                a.total_parts,
                a.inspection_name,
                a.order_number,
                a.inspection_start_date,
                a.inspection_end_date,
                a.last_edited_at,
                a.created_at,
                a.service_note,
                a.audit_act_id,
                a.locked_by,
                (a.locked_by IS NOT NULL
                 AND a.lock_expires_at IS NOT NULL
                 AND a.lock_expires_at > CURRENT_TIMESTAMP) as is_locked,
                a.needs_created_date,
                a.needs_directive_number,
                a.needs_invoice_check,
                a.needs_service_note,
                a.validation_status,
                a.validation_issues
            FROM {self.acts} a
            ORDER BY
                COALESCE(a.last_edited_at, a.created_at) DESC,
                a.created_at DESC
            LIMIT $1 OFFSET $2
            """,
            limit,
            offset,
        )
        # «Администратор» как роль пользователя — литерал (не из БД).
        return [
            self._build_act_list_item({**dict(row), "user_role": "Администратор"})
            for row in rows
        ]

    async def get_user_acts_needing_attention(
        self, username: str, *, limit: int = 200,
    ) -> list[ActAttentionItem]:
        """Возвращает ВСЕ акты пользователя, требующие внимания (без пагинации).

        Сводка для колокольчика лендинга: акты с незакрытыми требованиями
        (needs_* — фактура/дата/поручения/СЗ; поддерживаются ETL) ИЛИ
        со структурной валидацией не 'ok' (validation_status пишется при
        сохранении). Заблокированные (живой lock) исключаем — как делал прежний
        клиентский живой источник. Один дешёвый запрос вместо клиентского
        пересчёта по сотне актов; читает те же колонки, что и список.

        ``limit`` — потолок размера ответа (защита от патологического payload);
        реалистично у пользователя их кратно меньше.
        """
        rows = await self.conn.fetch(
            f"""
            SELECT
                a.id,
                a.inspection_name,
                a.needs_created_date,
                a.needs_directive_number,
                a.needs_invoice_check,
                a.needs_service_note,
                a.validation_status,
                a.validation_issues
            FROM {self.acts} a
            WHERE EXISTS (
                SELECT 1 FROM {self.audit_team} atm
                WHERE atm.act_id = a.id AND atm.username = $1
            )
              AND NOT (
                a.locked_by IS NOT NULL
                AND a.lock_expires_at IS NOT NULL
                AND a.lock_expires_at > CURRENT_TIMESTAMP
              )
              AND (
                a.needs_created_date
                OR a.needs_directive_number
                OR a.needs_invoice_check
                OR a.needs_service_note
                OR a.validation_status <> 'ok'
              )
            ORDER BY
                COALESCE(a.last_edited_at, a.created_at) DESC,
                a.created_at DESC
            LIMIT $2
            """,
            username,
            limit,
        )

        return [
            ActAttentionItem(
                id=row["id"],
                inspection_name=row["inspection_name"],
                needs_created_date=row["needs_created_date"],
                needs_directive_number=row["needs_directive_number"],
                needs_invoice_check=row["needs_invoice_check"],
                needs_service_note=row["needs_service_note"],
                validation_status=row["validation_status"],
                validation_issues=_parse_validation_issues(row["validation_issues"]),
            )
            for row in rows
        ]

    async def _fetch_act(self, act_id: int, *, for_update: bool = False) -> ActResponse:
        """Загружает акт с участниками и поручениями.

        Args:
            act_id: ID акта.
            for_update: если True, добавляет FOR UPDATE к SELECT акта.
        """
        lock_clause = "FOR UPDATE" if for_update else ""
        act_row = await self.conn.fetchrow(
            f"""
            SELECT
                id, km_number, part_number, total_parts,
                inspection_name, city, created_date,
                order_number, order_date, is_process_based,
                service_note, service_note_date,
                audit_act_id,
                inspection_start_date, inspection_end_date,
                needs_created_date, needs_directive_number,
                needs_invoice_check, needs_service_note,
                validation_status, validation_issues,
                created_at, updated_at, created_by,
                last_edited_by, last_edited_at
            FROM {self.acts}
            WHERE id = $1
            {lock_clause}
            """,
            act_id,
        )

        if not act_row:
            raise ActNotFoundError(f"Акт ID={act_id} не найден")

        team_rows = await self.conn.fetch(
            f"""
            SELECT role, full_name, position, username
            FROM {self.audit_team}
            WHERE act_id = $1
            ORDER BY order_index
            """,
            act_id,
        )

        audit_team = [
            AuditTeamMember(
                role=row["role"],
                full_name=row["full_name"],
                position=row["position"],
                username=row["username"],
            )
            for row in team_rows
        ]

        directive_rows = await self.conn.fetch(
            f"""
            SELECT point_number, node_id, directive_number
            FROM {self.directives}
            WHERE act_id = $1
            ORDER BY order_index
            """,
            act_id,
        )

        directives = [
            ActDirective(
                point_number=row["point_number"],
                directive_number=row["directive_number"],
                node_id=row["node_id"],
            )
            for row in directive_rows
        ]

        return ActResponse(
            id=act_row["id"],
            km_number=act_row["km_number"],
            part_number=act_row["part_number"],
            total_parts=act_row["total_parts"],
            inspection_name=act_row["inspection_name"],
            city=act_row["city"],
            created_date=act_row["created_date"],
            order_number=act_row["order_number"],
            order_date=act_row["order_date"],
            is_process_based=act_row["is_process_based"],
            service_note=act_row["service_note"],
            service_note_date=act_row["service_note_date"],
            audit_act_id=act_row["audit_act_id"],
            inspection_start_date=act_row["inspection_start_date"],
            inspection_end_date=act_row["inspection_end_date"],
            audit_team=audit_team,
            directives=directives,
            needs_created_date=act_row["needs_created_date"],
            needs_directive_number=act_row["needs_directive_number"],
            needs_invoice_check=act_row["needs_invoice_check"],
            needs_service_note=act_row["needs_service_note"],
            validation_status=act_row["validation_status"],
            validation_issues=_parse_validation_issues(act_row["validation_issues"]),
            created_at=act_row["created_at"],
            updated_at=act_row["updated_at"],
            created_by=act_row["created_by"],
            last_edited_by=act_row["last_edited_by"],
            last_edited_at=act_row["last_edited_at"],
        )

    async def get_act_by_id(self, act_id: int) -> ActResponse:
        """Получает полную информацию об акте по его ID."""
        return await self._fetch_act(act_id)

    async def get_act_by_id_for_update(self, act_id: int) -> ActResponse:
        """Получает акт с блокировкой строки (SELECT ... FOR UPDATE)."""
        return await self._fetch_act(act_id, for_update=True)

    # -------------------------------------------------------------------------
    # ОБНОВЛЕНИЕ МЕТАДАННЫХ (атомарный UPDATE)
    # -------------------------------------------------------------------------

    async def execute_update(
        self, act_id: int, updates: list[str], values: list,
    ) -> None:
        """Выполняет динамический UPDATE для акта."""
        if not updates:
            return
        param_idx = len(values) + 1
        values.append(act_id)
        await self.conn.execute(
            f"""
            UPDATE {self.acts}
            SET {', '.join(updates)}
            WHERE id = ${param_idx}
            """,
            *values,
        )

    async def get_audit_act_id(self, act_id: int) -> str | None:
        """Получает audit_act_id для акта."""
        return await self.conn.fetchval(
            f"SELECT audit_act_id FROM {self.acts} WHERE id = $1",
            act_id,
        )

    async def check_name_exists(self, name: str) -> bool:
        """Проверяет существование акта с таким inspection_name."""
        return await self.conn.fetchval(
            f"SELECT EXISTS(SELECT 1 FROM {self.acts} WHERE inspection_name = $1)",
            name,
        )

    # -------------------------------------------------------------------------
    # УДАЛЕНИЕ
    # -------------------------------------------------------------------------

    # Порядок важен: сначала зависимые таблицы, потом родительская
    _CHILD_TABLES = [
        "act_invoices",
        "act_violations",
        "act_textblocks",
        "act_tables",
        "act_tree",
        "act_directives",
        "audit_team_members",
    ]

    async def delete_by_id(self, act_id: int) -> None:
        """Удаляет акт со всеми связанными данными."""
        if self.adapter.supports_cascade_delete():
            # PostgreSQL: ON DELETE CASCADE сделает всё
            await self.conn.execute(
                f"DELETE FROM {self.acts} WHERE id = $1", act_id
            )
        else:
            # Greenplum: явное удаление в правильном порядке
            async with self.conn.transaction():
                for table in self._CHILD_TABLES:
                    table_name = self.adapter.get_table_name(table)
                    await self.conn.execute(
                        f"DELETE FROM {table_name} WHERE act_id = $1", act_id
                    )
                await self.conn.execute(
                    f"DELETE FROM {self.acts} WHERE id = $1", act_id
                )
        logger.debug(f"Акт ID={act_id} удален")
