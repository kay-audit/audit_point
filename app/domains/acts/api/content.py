"""
API эндпоинты для работы с содержимым актов.

Тонкие обёртки — вся логика в ActContentService.
"""

import logging

from fastapi import APIRouter, Depends

logger = logging.getLogger("audit_workstation.api.acts.content")

from app.api.v1.deps.auth_deps import get_username
from app.schemas.errors import ErrorDetail
from app.domains.acts.deps import get_content_service
from app.domains.acts.schemas.act_content import ActDataSchema
from app.domains.acts.schemas.act_responses import SaveContentResponse
from app.domains.acts.services.act_content_service import ActContentService

router = APIRouter()


@router.get(
    "/{act_id}/content",
    responses={
        403: {"description": "Нет доступа к акту", "model": ErrorDetail},
        404: {"description": "Акт не найден", "model": ErrorDetail},
    },
)
async def get_act_content(
    act_id: int,
    username: str = Depends(get_username),
    service: ActContentService = Depends(get_content_service),
) -> dict:
    """Получает полное содержимое акта для редактора."""
    return await service.get_content(act_id, username)


@router.put(
    "/{act_id}/content",
    response_model=SaveContentResponse,
    responses={
        403: {"description": "Нет прав на редактирование", "model": ErrorDetail},
        404: {"description": "Акт не найден", "model": ErrorDetail},
        409: {
            "description": (
                "Блокировка не принадлежит пользователю (act-locked) или "
                "содержимое изменено конкурентно (content-conflict)"
            ),
            "model": ErrorDetail,
        },
        422: {"description": "Ошибка валидации входных данных"},
    },
)
async def save_act_content(
    act_id: int,
    data: ActDataSchema,
    username: str = Depends(get_username),
    service: ActContentService = Depends(get_content_service),
) -> dict:
    """Сохраняет содержимое акта."""
    result = await service.save_content(act_id, data, username)
    logger.info("Сохранено содержимое акта id=%s пользователем %s", act_id, username)
    return result
