"""
DI-зависимости домена ua_data.

Предоставляет get_dictionary_service для использования в FastAPI Depends —
собирает DictionaryService поверх DictionaryRepository на исполнителе БД
(``get_executor()``): соединение берётся из пула на время одного SQL-вызова
или одной явной транзакции, а не на весь HTTP-запрос.
"""

from app.db.executor import get_executor
from app.domains.ua_data.repositories.dictionary_repository import (
    DictionaryRepository,
)
from app.domains.ua_data.services.dictionary_service import DictionaryService


def get_dictionary_service() -> DictionaryService:
    """Создаёт DictionaryService на исполнителе БД."""
    repo = DictionaryRepository(get_executor())
    return DictionaryService(repo=repo)
