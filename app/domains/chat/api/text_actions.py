"""Эндпоинты text-actions.

- ``POST /chat/text-actions/correct`` — обработка выделенного текста (Фича
  «Корректор») в режиме ``fix`` (орфография/пунктуация) или ``readability``
  (улучшение читаемости/структуры).
- ``POST /chat/text-actions/formalize-violation`` — раскладка свободного текста
  нарушения по полям карточки (Фича «Формализация»).
"""

from fastapi import APIRouter, Depends

from app.api.v1.deps.role_deps import require_domain_access
from app.domains.chat.deps import (
    get_text_corrector_service,
    get_violation_formalizer_service,
)
from app.domains.chat.schemas.text_actions import (
    CorrectRequest,
    CorrectResponse,
    FormalizeRequest,
    FormalizeResponse,
)

router = APIRouter(
    prefix="/text-actions",
    dependencies=[Depends(require_domain_access("chat"))],
)


@router.post("/correct", response_model=CorrectResponse)
async def correct_text(
    body: CorrectRequest,
    service=Depends(get_text_corrector_service),
) -> CorrectResponse:
    """Обработать выделенный текст: орфография/пунктуация (``fix``) или
    улучшение читаемости/структуры (``readability``).

    В режиме ``readability`` ответ дополнительно содержит ``readability`` —
    индекс тяжести и светофор до и после правки (анализатор D17)."""
    return await service.correct(body.text, body.mode)


@router.post("/formalize-violation", response_model=FormalizeResponse)
async def formalize_violation(
    body: FormalizeRequest,
    service=Depends(get_violation_formalizer_service),
) -> FormalizeResponse:
    """Разложить свободный текст нарушения по полям карточки (Фича «Формализация»).

    Что LLM извлекла — заполняется, что нет — остаётся пустым. ``recommendations`` —
    дисплей-онли подсказки аналитику «чего не хватает», в карточку/экспорт не идут."""
    return await service.formalize(body.text)
