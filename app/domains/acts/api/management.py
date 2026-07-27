"""
API эндпоинты для управления актами.

Тонкие обёртки — вся логика в сервисах.
"""

import logging

from fastapi import APIRouter, Depends, Query

logger = logging.getLogger("audit_workstation.api.acts.management")

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.core.responses import PaginatedResponse
from app.domains.acts.deps import get_crud_service, get_lock_service, _get_acts_settings
from app.domains.acts.schemas.act_metadata import ActAttentionItem, ActCreate, ActUpdate, ActListItem, ActResponse, AuditPointIdsRequest
from app.schemas.errors import ErrorDetail, LockErrorDetail, KmConflictDetail
from app.domains.acts.schemas.act_responses import (
    LockConfigResponse,
    LockResponse,
    InvoiceConfigResponse,
    OperationResult,
)
from app.domains.acts.services.act_crud_service import ActCrudService
from app.domains.acts.services.act_lock_service import ActLockService
from app.domains.acts.settings import ActsSettings

router = APIRouter()


@router.get("/list", response_model=PaginatedResponse[ActListItem])
async def list_user_acts(
        username: str = Depends(get_username),
        limit: int = Query(50, ge=1, le=200),
        offset: int = Query(0, ge=0),
        roles: list[dict] = Depends(get_user_roles),
        service: ActCrudService = Depends(get_crud_service),
):
    """Получает список актов для страницы «Управление актами».

    Обычные пользователи видят только акты, в команде которых они состоят
    (роль из ``audit_team_members``).

    Администратор видит **ВСЕ** акты в системе — те, что созданы другими
    пользователями, в команде которых он может не состоять. Роль пользователя
    для таких актов подменяется на «Администратор» (системная роль — это не
    роль в рамках проверки, поэтому в ``audit_team_members`` её нет).
    """
    is_admin = any(r["name"] == "Администратор" for r in roles)
    items, total = await service.list_acts(
        username, limit=limit, offset=offset, is_admin=is_admin,
    )
    return PaginatedResponse[ActListItem](
        items=items, total=total, limit=limit, offset=offset,
    )


@router.get("/attention-summary", response_model=list[ActAttentionItem])
async def acts_attention_summary(
        username: str = Depends(get_username),
        service: ActCrudService = Depends(get_crud_service),
):
    """Сводка «мои акты, требующие внимания» для колокольчика лендинга.

    Серверный пересчёт по всем актам пользователя (не по загруженной странице):
    незакрытые требования (фактура/дата/поручения/СЗ) или структурная валидация
    не 'ok'. Read-only; флаги меняются редко (фактура — на стороне ETL), поэтому
    фронт опрашивает эндпоинт нечасто. Маршрут — ДО ``/{act_id}``.
    """
    return await service.get_attention_summary(username)


@router.post("/{act_id}/lock", response_model=LockResponse, status_code=200, responses={403: {"description": "Нет доступа к акту", "model": ErrorDetail}, 404: {"description": "Акт не найден", "model": ErrorDetail}, 409: {"description": "Акт заблокирован другим пользователем", "model": LockErrorDetail}})
async def lock_act(
        act_id: int,
        username: str = Depends(get_username),
        service: ActLockService = Depends(get_lock_service),
):
    """Блокирует акт для редактирования текущим пользователем."""
    return await service.lock_act(act_id, username)


@router.post("/{act_id}/unlock", response_model=OperationResult, status_code=200, responses={403: {"description": "Нет доступа к акту", "model": ErrorDetail}, 404: {"description": "Акт не найден", "model": ErrorDetail}, 409: {"description": "Блокировка не принадлежит пользователю", "model": ErrorDetail}})
async def unlock_act(
        act_id: int,
        username: str = Depends(get_username),
        service: ActLockService = Depends(get_lock_service),
):
    """Снимает блокировку с акта."""
    return await service.unlock_act(act_id, username)


@router.post("/{act_id}/extend-lock", response_model=LockResponse, status_code=200, responses={403: {"description": "Нет доступа к акту", "model": ErrorDetail}, 404: {"description": "Акт не найден", "model": ErrorDetail}, 409: {"description": "Блокировка не принадлежит пользователю", "model": LockErrorDetail}})
async def extend_lock(
        act_id: int,
        username: str = Depends(get_username),
        service: ActLockService = Depends(get_lock_service),
):
    """Продлевает блокировку акта."""
    return await service.extend_lock(act_id, username)


@router.post("/create", response_model=ActResponse, status_code=201, responses={409: {"description": "Акт с таким КМ уже существует", "model": KmConflictDetail}, 422: {"description": "Ошибка валидации входных данных"}})
async def create_act(
        act_data: ActCreate,
        username: str = Depends(get_username),
        force_new_part: bool = False,
        service: ActCrudService = Depends(get_crud_service),
):
    """Создает новый акт с метаданными и связанными сущностями."""
    result = await service.create_act(act_data, username, force_new_part)
    logger.info("Создан акт id=%s пользователем %s", result.id, username)
    return result


@router.get("/config/lock", response_model=LockConfigResponse)
async def get_lock_config(
        acts_cfg: ActsSettings = Depends(_get_acts_settings),
):
    """Получает настройки блокировок для фронтенда."""
    return {
        "lockDurationMinutes": acts_cfg.lock.duration_minutes,
        "inactivityTimeoutMinutes": acts_cfg.lock.inactivity_timeout_minutes,
        "inactivityCheckIntervalSeconds": acts_cfg.lock.inactivity_check_interval_seconds,
        "minExtensionIntervalMinutes": acts_cfg.lock.min_extension_interval_minutes,
        "inactivityDialogTimeoutSeconds": acts_cfg.lock.inactivity_dialog_timeout_seconds,
        "autoSavePeriodSeconds": acts_cfg.autosave.period_seconds,
    }


@router.get("/config/invoice", response_model=InvoiceConfigResponse)
async def get_invoice_config(
        acts_cfg: ActsSettings = Depends(_get_acts_settings),
):
    """Получает настройки схем для фактур (для фронтенда)."""
    return {
        "hiveSchema": acts_cfg.invoice.hive_schema,
        "gpSchema": acts_cfg.invoice.gp_schema,
    }


@router.get("/{act_id}", response_model=ActResponse, responses={403: {"description": "Нет доступа к акту", "model": ErrorDetail}, 404: {"description": "Акт не найден", "model": ErrorDetail}})
async def get_act(
        act_id: int,
        username: str = Depends(get_username),
        service: ActCrudService = Depends(get_crud_service),
):
    """Получает полную информацию об акте."""
    return await service.get_act(act_id, username)


@router.patch("/{act_id}", response_model=ActResponse, responses={403: {"description": "Нет прав на редактирование", "model": ErrorDetail}, 404: {"description": "Акт не найден", "model": ErrorDetail}, 409: {"description": "Конфликт данных", "model": ErrorDetail}, 422: {"description": "Ошибка валидации входных данных"}})
async def update_act_metadata(
        act_id: int,
        act_update: ActUpdate,
        username: str = Depends(get_username),
        service: ActCrudService = Depends(get_crud_service),
):
    """Обновляет метаданные акта (частичное обновление)."""
    result = await service.update_act_metadata(act_id, act_update, username)
    logger.info("Обновлены метаданные акта id=%s пользователем %s", act_id, username)
    return result


@router.post("/{act_id}/duplicate", response_model=ActResponse, responses={403: {"description": "Нет доступа к акту", "model": ErrorDetail}, 404: {"description": "Акт не найден", "model": ErrorDetail}})
async def duplicate_act(
        act_id: int,
        username: str = Depends(get_username),
        service: ActCrudService = Depends(get_crud_service),
):
    """Создает дубликат акта."""
    result = await service.duplicate_act(act_id, username)
    logger.info("Дублирован акт id=%s → id=%s пользователем %s", act_id, result.id, username)
    return result


@router.post("/{act_id}/audit-point-ids", response_model=dict[str, str], responses={403: {"description": "Нет доступа к акту", "model": ErrorDetail}, 404: {"description": "Акт не найден", "model": ErrorDetail}})
async def generate_audit_point_ids(
        act_id: int,
        request: AuditPointIdsRequest,
        username: str = Depends(get_username),
        service: ActCrudService = Depends(get_crud_service),
):
    """Генерирует audit_point_id для списка узлов дерева акта."""
    return await service.generate_audit_point_ids(act_id, request.node_ids, username)


@router.delete("/{act_id}", response_model=OperationResult, responses={403: {"description": "Нет прав на удаление", "model": ErrorDetail}, 404: {"description": "Акт не найден", "model": ErrorDetail}})
async def delete_act(
        act_id: int,
        username: str = Depends(get_username),
        service: ActCrudService = Depends(get_crud_service),
):
    """Удаляет акт и все связанные данные."""
    result = await service.delete_act(act_id, username)
    logger.info("Удалён акт id=%s пользователем %s", act_id, username)
    return result
