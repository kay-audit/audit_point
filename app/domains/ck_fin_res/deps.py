"""
DI-зависимости домена ЦК Фин.Рез.

Предоставляет get_fr_validation_service для использования в FastAPI Depends.
Сервис строится на исполнителе БД (``get_executor()``): соединение берётся
из пула на время одного SQL-вызова или одной явной транзакции, а не на весь
HTTP-запрос.
"""

from app.db.executor import get_executor
from app.domains.ck_fin_res.repositories.fr_validation_repository import (
    FRValidationRepository,
)
from app.domains.ck_fin_res.services.fr_validation_service import (
    FRValidationService,
)
from app.domains.ua_data.interfaces import IDictionaryRepository


async def get_fr_validation_service() -> FRValidationService:
    """Создаёт FRValidationService на исполнителе БД.

    DictionaryRepository разрешается через ``domain_registry.get_factory`` —
    cross-domain зависимость идёт через Protocol, без прямого импорта класса.
    """
    from app.core.domain_registry import get_factory

    ex = get_executor()
    fr_repo = FRValidationRepository(ex)
    dict_repo: IDictionaryRepository = get_factory(
        "ua_data.dictionary_repository"
    )(ex)
    return FRValidationService(fr_repo=fr_repo, dict_repo=dict_repo)
