"""Репозиторий аудит-лога отказов доступа к доменам.

Append-only журнал случаев, когда ``require_domain_access`` вернул 403.
Запись делается через bulk-INSERT внутри батчера, чтобы 403-ответ
не задерживался ожиданием БД.
"""

import logging
from dataclasses import dataclass

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn

logger = logging.getLogger(
    "audit_workstation.domains.admin.repo.access_denied_audit"
)


@dataclass(frozen=True, slots=True)
class AccessDeniedRecord:
    """Одна запись об отказе доступа для bulk-сохранения через ``log_many``."""
    username: str
    domain: str
    path: str
    method: str
    reason: str | None


class AccessDeniedAuditRepository(BaseRepository):
    """Append-only журнал отказов доступа к доменам."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.table = self.adapter.get_table_name("access_denied_audit")

    async def log_many(self, records: list[AccessDeniedRecord]) -> None:
        """Bulk-INSERT пакета записей одним ``executemany`` в транзакции.

        Пустой список — no-op (не открываем транзакцию зря).
        """
        if not records:
            return
        params = [
            (r.username, r.domain, r.path, r.method, r.reason)
            for r in records
        ]
        async with self.conn.transaction():
            await self.conn.executemany(
                f"""
                INSERT INTO {self.table}
                    (username, domain, path, method, reason)
                VALUES ($1, $2, $3, $4, $5)
                """,
                params,
            )
