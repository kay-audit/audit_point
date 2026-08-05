"""
Репозиторий фактур актов.
"""

import json
import logging

import asyncpg

from app.domains.acts.exceptions import InvoiceError
from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.db.utils.sql_utils import quote_ident

logger = logging.getLogger("audit_workstation.db.repository.invoice")


class ActInvoiceRepository(BaseRepository):
    """Работа с фактурами актов: справочники, CRUD, верификация."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.invoices = self.adapter.get_table_name("act_invoices")

    @staticmethod
    def _row_to_dict(row) -> dict:
        """Конвертирует строку БД в словарь фактуры."""
        metrics = row["metrics"]
        if isinstance(metrics, str):
            metrics = json.loads(metrics)

        process = row.get("process")
        if isinstance(process, str):
            process = json.loads(process)

        return {
            "id": row["id"],
            "act_id": row["act_id"],
            "node_id": row["node_id"],
            "node_number": row["node_number"],
            "db_type": row["db_type"],
            "schema_name": row["schema_name"],
            "table_name": row["table_name"],
            "metrics": metrics,
            "process": process,
            "profile_div": row.get("profile_div"),
            "verification_status": row["verification_status"],
            "created_at": row["created_at"].isoformat(),
            "updated_at": row["updated_at"].isoformat(),
            "created_by": row["created_by"],
        }

    async def list_metric_dict(
        self,
        registry_schema: str,
        metric_table: str,
    ) -> list[dict]:
        """
        Возвращает справочник метрик из таблицы t_db_oarb_ua_violation_metric_dict.

        Args:
            registry_schema: Имя схемы (public для PostgreSQL, hive_registry_schema для GP)
            metric_table: Имя таблицы справочника метрик

        Returns:
            Список словарей {code, metric_name, metric_group}
        """
        rows = await self.conn.fetch(
            f'SELECT code, metric_name, metric_group '
            f'FROM {quote_ident(registry_schema)}.{quote_ident(metric_table)} '
            f'ORDER BY code',
        )

        return [
            {
                "code": row["code"],
                "metric_name": row["metric_name"],
                "metric_group": row["metric_group"],
            }
            for row in rows
        ]

    async def list_process_dict(
        self,
        registry_schema: str,
        process_table: str,
    ) -> list[dict]:
        """Возвращает справочник процессов."""
        rows = await self.conn.fetch(
            f'SELECT process_code, process_name '
            f'FROM {quote_ident(registry_schema)}.{quote_ident(process_table)} '
            f'ORDER BY process_code',
        )
        return [
            {"process_code": row["process_code"], "process_name": row["process_name"]}
            for row in rows
        ]

    async def list_subsidiary_dict(
        self,
        registry_schema: str,
        subsidiary_table: str,
    ) -> list[dict]:
        """Возвращает справочник подразделений."""
        rows = await self.conn.fetch(
            f'SELECT subsidiary_name '
            f'FROM {quote_ident(registry_schema)}.{quote_ident(subsidiary_table)} '
            f'ORDER BY subsidiary_name',
        )
        return [{"name": row["subsidiary_name"]} for row in rows]

    async def list_tables(
        self,
        db_type: str,
        *,
        hive_registry_schema: str | None = None,
        hive_registry_table: str | None = None,
        gp_target_schema: str | None = None,
    ) -> list[dict]:
        """
        Возвращает полный список таблиц в указанной БД.

        Args:
            db_type: Тип БД (hive, greenplum)
            hive_registry_schema: Схема реестра Hive-таблиц
            hive_registry_table: Таблица реестра Hive
            gp_target_schema: Целевая схема Greenplum

        Returns:
            Список словарей {table_name}

        Raises:
            InvoiceError: Если db_type не поддерживается
        """
        if db_type == "hive":
            rows = await self.conn.fetch(
                f'SELECT table_name '
                f'FROM {quote_ident(hive_registry_schema)}.{quote_ident(hive_registry_table)} '
                f'ORDER BY table_name',
            )
            return [
                {"table_name": row["table_name"]}
                for row in rows
            ]

        elif db_type == "greenplum":
            rows = await self.conn.fetch(
                "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
                gp_target_schema,
            )
            return [
                {"table_name": row["tablename"]}
                for row in rows
            ]

        else:
            raise InvoiceError(f"Неподдерживаемый тип БД: {db_type}")

    async def save_invoice(self, data: dict, username: str) -> dict:
        """
        Сохраняет фактуру (UPSERT по act_id + node_id).

        Args:
            data: Словарь с данными фактуры
            username: Имя пользователя

        Returns:
            Словарь с данными сохраненной фактуры
        """
        metrics_json = json.dumps(data["metrics"], ensure_ascii=False)
        process_raw = data.get("process")
        process_json = json.dumps(process_raw, ensure_ascii=False) if process_raw is not None else None

        if self.adapter.supports_on_conflict():
            # PostgreSQL: INSERT ... ON CONFLICT DO UPDATE
            row = await self.conn.fetchrow(
                f"""
                INSERT INTO {self.invoices} (
                    act_id, node_id, node_number, db_type,
                    schema_name, table_name, metrics,
                    process, profile_div, created_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
                ON CONFLICT (act_id, node_id) DO UPDATE SET
                    node_number = EXCLUDED.node_number,
                    db_type = EXCLUDED.db_type,
                    schema_name = EXCLUDED.schema_name,
                    table_name = EXCLUDED.table_name,
                    metrics = EXCLUDED.metrics,
                    process = EXCLUDED.process,
                    profile_div = EXCLUDED.profile_div,
                    verification_status = 'pending',
                    updated_at = CURRENT_TIMESTAMP,
                    etl_loading_id = NULL,
                    create_date = NULL
                RETURNING id, act_id, node_id, node_number, db_type,
                          schema_name, table_name, metrics,
                          process, profile_div,
                          verification_status, created_at, updated_at, created_by
                """,
                data["act_id"],
                data["node_id"],
                data.get("node_number"),
                data["db_type"],
                data["schema_name"],
                data["table_name"],
                metrics_json,
                process_json,
                data.get("profile_div"),
                username,
            )
        else:
            # Greenplum: UPDATE + fallback INSERT с retry при race condition
            row = None
            for attempt in range(2):
                row = await self.conn.fetchrow(
                    f"""
                    UPDATE {self.invoices} SET
                        node_number = $3,
                        db_type = $4,
                        schema_name = $5,
                        table_name = $6,
                        metrics = $7::jsonb,
                        process = $8::jsonb,
                        profile_div = $9,
                        verification_status = 'pending',
                        updated_at = CURRENT_TIMESTAMP,
                        etl_loading_id = NULL,
                        create_date = NULL
                    WHERE act_id = $1 AND node_id = $2
                    RETURNING id, act_id, node_id, node_number, db_type,
                              schema_name, table_name, metrics,
                              process, profile_div,
                              verification_status, created_at, updated_at, created_by
                    """,
                    data["act_id"],
                    data["node_id"],
                    data.get("node_number"),
                    data["db_type"],
                    data["schema_name"],
                    data["table_name"],
                    metrics_json,
                    process_json,
                    data.get("profile_div"),
                )
                if row:
                    break
                try:
                    row = await self.conn.fetchrow(
                        f"""
                        INSERT INTO {self.invoices} (
                            act_id, node_id, node_number, db_type,
                            schema_name, table_name, metrics,
                            process, profile_div, created_by
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
                        RETURNING id, act_id, node_id, node_number, db_type,
                                  schema_name, table_name, metrics,
                                  process, profile_div,
                                  verification_status, created_at, updated_at, created_by
                        """,
                        data["act_id"],
                        data["node_id"],
                        data.get("node_number"),
                        data["db_type"],
                        data["schema_name"],
                        data["table_name"],
                        metrics_json,
                        process_json,
                        data.get("profile_div"),
                        username,
                    )
                    break
                except asyncpg.UniqueViolationError:
                    if attempt == 0:
                        logger.info(
                            f"UPSERT race condition для act_id={data['act_id']}, "
                            f"node_id={data['node_id']}, повторная попытка"
                        )
                        continue
                    raise

        logger.info(
            f"Фактура сохранена: act_id={data['act_id']}, "
            f"node_id={data['node_id']}, table={data['table_name']}"
        )

        return self._row_to_dict(row)

    async def get_invoice_for_node(
            self,
            act_id: int,
            node_id: str,
    ) -> dict | None:
        """Получает фактуру для конкретного узла."""
        row = await self.conn.fetchrow(
            f"""
            SELECT id, act_id, node_id, node_number, db_type,
                   schema_name, table_name, metrics,
                   process, profile_div,
                   verification_status, created_at, updated_at, created_by
            FROM {self.invoices}
            WHERE act_id = $1 AND node_id = $2
            """,
            act_id,
            node_id,
        )

        if not row:
            return None

        return self._row_to_dict(row)

    async def get_invoices_for_act(self, act_id: int) -> list[dict]:
        """Получает все фактуры для акта."""
        rows = await self.conn.fetch(
            f"""
            SELECT id, act_id, node_id, node_number, db_type,
                   schema_name, table_name, metrics,
                   process, profile_div,
                   verification_status, created_at, updated_at, created_by
            FROM {self.invoices}
            WHERE act_id = $1
            ORDER BY node_number, created_at
            """,
            act_id,
        )

        return [self._row_to_dict(row) for row in rows]

    async def verify_invoice(self, invoice_id: int) -> dict:
        """
        Верификация фактуры (TODO-заглушка).

        В будущем здесь будет вызов внешнего сервиса для проверки
        соответствия фактуры и данных в таблице.
        """
        logger.info(f"TODO: Верификация фактуры ID={invoice_id} (заглушка)")
        return {
            "invoice_id": invoice_id,
            "status": "pending",
            "message": "Верификация пока не реализована",
        }
