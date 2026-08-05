"""Репозиторий HTTP-метрик запросов."""

import logging
from dataclasses import dataclass

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn

logger = logging.getLogger(
    "audit_workstation.domains.admin.repo.http_metrics"
)


@dataclass(frozen=True, slots=True)
class HttpMetricRecord:
    """Одна HTTP-метрика для bulk-записи через ``record_many``."""
    method: str
    path: str
    status_code: int
    latency_ms: int
    username: str | None
    request_id: str | None


class HttpMetricsRepository(BaseRepository):
    """Append-only журнал HTTP-запросов: метод, путь, статус, latency."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.table = self.adapter.get_table_name("admin_http_metrics")

    async def record(
        self,
        method: str,
        path: str,
        status_code: int,
        latency_ms: int,
        username: str | None,
        request_id: str | None,
    ) -> None:
        """Записывает одну HTTP-метрику.

        :param method: HTTP-метод (GET/POST/...).
        :param path: путь запроса без query string.
        :param status_code: HTTP-статус ответа.
        :param latency_ms: длительность обработки запроса в миллисекундах.
        :param username: имя пользователя (None для unauthenticated).
        :param request_id: id из RequestIdMiddleware (None если недоступен).
        """
        await self.conn.execute(
            f"""
            INSERT INTO {self.table}
                (method, path, status_code, latency_ms, username, request_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            method,
            path,
            int(status_code),
            int(latency_ms),
            username,
            request_id,
        )

    async def record_many(self, records: list[HttpMetricRecord]) -> None:
        """Bulk-INSERT пакета HTTP-метрик одним ``executemany`` в транзакции.

        Пустой список — no-op (не открываем транзакцию зря).
        """
        if not records:
            return
        params = [
            (
                r.method,
                r.path,
                int(r.status_code),
                int(r.latency_ms),
                r.username,
                r.request_id,
            )
            for r in records
        ]
        async with self.conn.transaction():
            await self.conn.executemany(
                f"""
                INSERT INTO {self.table}
                    (method, path, status_code, latency_ms, username, request_id)
                VALUES ($1, $2, $3, $4, $5, $6)
                """,
                params,
            )
