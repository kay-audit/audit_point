"""
DI-зависимости домена ЦК Клиентский опыт.

Предоставляет get_cs_validation_service для использования в FastAPI Depends.
Сервис строится на исполнителе БД (``get_executor()``): соединение берётся
из пула на время одного SQL-вызова или одной явной транзакции, а не на весь
HTTP-запрос.
"""

from app.db.executor import get_executor
from app.domains.ck_client_exp.repositories.cs_validation_repository import (
    CSValidationRepository,
)
from app.domains.ck_client_exp.services.cs_validation_service import (
    CSValidationService,
)
from app.domains.ua_data.interfaces import IDictionaryRepository


async def get_cs_validation_service() -> CSValidationService:
    """Создаёт CSValidationService на исполнителе БД.

    DictionaryRepository разрешается через ``domain_registry.get_factory`` —
    cross-domain зависимость идёт через Protocol, без прямого импорта класса.
    """
    from app.core.domain_registry import get_factory

    ex = get_executor()
    cs_repo = CSValidationRepository(ex)
    dict_repo: IDictionaryRepository = get_factory(
        "ua_data.dictionary_repository"
    )(ex)
    return CSValidationService(cs_repo=cs_repo, dict_repo=dict_repo)
