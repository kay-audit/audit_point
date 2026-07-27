"""Pydantic схемы для эндпоинтов администрирования."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# Фиксированный список допустимых ТБ (территориальных банков).
# Используется в Pydantic-схемах и в JS-форме редактирования пользователя.
TB_CODES: tuple[str, ...] = (
    "СРБ", "СИБ", "ББ", "ВВБ", "МБ", "ЦЧБ", "СЗБ", "ЮЗБ", "ДВБ", "УБ", "ПБ", "ЦА",
)


class RoleSchema(BaseModel):
    """Роль в системе."""
    id: int
    name: str
    domain_name: str | None = None
    description: str = ""


class UserRolesResponse(BaseModel):
    """Ответ с ролями пользователя."""
    username: str
    roles: list[RoleSchema]
    is_admin: bool


class UserDirectoryItem(BaseModel):
    """Пользователь из справочника с назначенными ролями."""
    username: str
    fullname: str = ""
    job: str = ""
    tn: str = ""
    email: str = ""
    # Территориальный банк (ТБ): буквенное обозначение из TB_CODES,
    # пустая строка если не заполнено.
    tb: str = ""
    # Soft-delete: true = пользователь помечен как удалённый. В UI
    # показывается плашка «УДАЛЕН», кнопки редактирования/удаления
    # блокируются.
    is_deleted: bool = False
    deleted_by: str = ""
    deleted_at: Optional[datetime] = None
    roles: list[RoleSchema] = []
    is_department: bool = True


class UserSearchResult(BaseModel):
    """Результат поиска пользователя в справочнике."""
    username: str
    fullname: str = ""
    job: str = ""
    email: str = ""
    tb: str = ""


class RoleAssignRequest(BaseModel):
    """Запрос на назначение роли пользователю."""
    role_id: int


class UserCreateRequest(BaseModel):
    """Создание/обновление пользователя в справочнике с опциональным назначением ролей.

    Используется администратором для онбординга пользователей, которых ещё нет
    в справочнике (например, локально при отсутствии EDW/Hive), либо для
    обновления полей уже существующего пользователя. Если пользователь с
    таким ``username`` уже существует — поля справочника обновляются
    (upsert-семантика), а роли из ``role_ids`` добавляются к существующим
    (idempotent).

    ВАЖНО: роль «Администратор» НЕ включается автоматически — её можно
    назначить только отдельной осознанной отметкой (см. ``role_ids`` и
    проверки на стороне сервиса).
    """
    username: str = Field(..., min_length=1, max_length=50)
    fullname: str = Field(..., min_length=1, max_length=255)
    job: str = Field(default="", max_length=255)
    tn: str = Field(default="", max_length=50)
    email: str = Field(default="", max_length=255)
    branch: str = Field(default="", max_length=255)
    tb: str = Field(default="", max_length=16)
    role_ids: list[int] = Field(default_factory=list)


class UserUpdateRequest(BaseModel):
    """Обновление метаданных пользователя (без изменения ролей).

    Используется админ-панелью для кнопки «Редактировать». Не меняет
    пароль, роли и soft-delete флаги — для каждого из этих аспектов
    есть отдельный эндпоинт.
    """
    fullname: str = Field(..., min_length=1, max_length=255)
    job: str = Field(default="", max_length=255)
    tn: str = Field(default="", max_length=50)
    email: str = Field(default="", max_length=255)
    branch: str = Field(default="", max_length=255)
    tb: str = Field(default="", max_length=16)


class AuditLogEntry(BaseModel):
    """Запись аудит-лога администрирования."""
    id: int
    action: str
    target_username: str
    admin_username: str
    role_id: int | None = None
    role_name: str = ""
    details: str = ""
    created_at: datetime
