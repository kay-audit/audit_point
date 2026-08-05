"""
Базовый репозиторий с общей инфраструктурой доступа к БД.
"""

from app.db.connection import get_adapter
from app.db.types import DbConn


class BaseRepository:
    """Базовый класс репозиториев: инкапсулирует соединение и адаптер."""

    def __init__(self, conn: DbConn):
        self.conn = conn
        self.adapter = get_adapter()
