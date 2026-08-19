import re
from datetime import date, datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AuditTeamMember(BaseModel):
    """Член аудиторской группы.

    Роль ``"AppendixRef"`` — служебное машинно-читаемое значение для строки-маркера
    «В соответствии с приложением №X к распоряжению УВА от <дата> № <номер>»: вместо
    отдельного человека в команде хранится одна запись с этой ролью, текстом маркера
    в ``full_name`` и заглушками в ``position``/``username``. Пользователю эта роль
    не отображается — фронт парсит ``full_name`` и рендерит специальный UI.
    """
    role: Literal["Куратор", "Руководитель", "Редактор", "Участник", "AppendixRef"]
    full_name: str = Field(min_length=1, max_length=255)
    position: str = Field(min_length=1, max_length=255)
    username: str = Field(min_length=1, max_length=255)


class UserSearchResult(BaseModel):
    """Результат поиска пользователя в справочнике."""
    username: str
    fullname: str = ""
    job: str = ""


class ActDirective(BaseModel):
    """Поручение"""
    point_number: str = Field(min_length=1, max_length=50)
    directive_number: str = Field(min_length=1, max_length=100)
    node_id: str | None = Field(default=None, max_length=100)

    @field_validator('point_number')
    @classmethod
    def validate_point_is_under_section_5(cls, v):
        """
        Проверяет что поручение относится к разделу 5.
        Допускается вложенность до 4 уровней включительно:
        - 5.X
        - 5.X.Y
        - 5.X.Y.Z

        Запрещено:
        - 5.X.Y.Z.W и глубже
        - Пункты не из раздела 5
        """
        # Очищаем лишние точки в начале и конце
        v = v.strip().rstrip('.')

        # Проверка принадлежности к разделу 5
        if not v.startswith('5.'):
            raise ValueError(
                f'Поручения могут быть только в разделе 5 (получено: {v})'
            )

        parts = v.split('.')

        # Минимум 2 части: "5" и "X"
        if len(parts) < 2:
            raise ValueError(
                f'Неверный формат пункта поручения: {v}. '
                f'Ожидается формат 5.X, 5.X.Y или 5.X.Y.Z'
            )

        # Максимум 4 уровня (5 + 3 подуровня)
        if len(parts) > 4:
            raise ValueError(
                f'Слишком глубокая вложенность пункта: {v}. '
                f'Максимум 4 уровня (например, 5.1.2.3)'
            )

        # Проверяем что все части после "5" - числа
        try:
            for part in parts[1:]:
                if part:  # Пропускаем пустые части
                    int(part)
        except ValueError:
            raise ValueError(
                f'Неверный формат пункта поручения: {v}. '
                f'Все части должны быть числами'
            )

        return v


class ActCreate(BaseModel):
    """Модель для создания акта"""
    km_number: str = Field(min_length=1, max_length=50)
    part_number: int = Field(default=1, ge=1)
    total_parts: int = Field(default=1, ge=1)
    inspection_name: str = Field(min_length=1)
    city: str = Field(min_length=1, max_length=255)
    created_date: Optional[date] = None
    order_number: str = Field(min_length=1, max_length=100)
    order_date: date
    audit_team: List[AuditTeamMember] = Field(min_length=1)
    inspection_start_date: date
    inspection_end_date: date
    is_process_based: bool = True
    directives: List[ActDirective] = Field(default_factory=list)

    # Новые поля
    service_note: Optional[str] = Field(default=None, max_length=100)
    service_note_date: Optional[date] = None

    @field_validator('km_number')
    @classmethod
    def validate_km_number_format(cls, v):
        """Проверяет формат КМ: КМ-XX-XXXXX"""
        pattern = r'^КМ-\d{2}-\d{5}$'
        if not re.match(pattern, v):
            raise ValueError(
                f'КМ номер должен быть в формате КМ-XX-XXXXX (например, КМ-99-94751), получено: {v}'
            )
        return v

    @field_validator('service_note')
    @classmethod
    def validate_service_note_format(cls, v):
        """Проверяет формат служебной записки: Текст/XXXX или принимает пустую строку как None"""
        # Пустая строка или None означает отсутствие СЗ
        if v is None or (isinstance(v, str) and v.strip() == ''):
            return None

        pattern = r'^.+/\d{4}$'
        if not re.match(pattern, v):
            raise ValueError(
                f'Служебная записка должна быть в формате Текст/XXXX '
                f'(например, ЦМ-75-вн/9475), получено: {v}'
            )

        # Проверяем что есть содержательная часть до "/"
        parts = v.rsplit('/', 1)
        if len(parts[0].strip()) == 0:
            raise ValueError('Служебная записка должна содержать текст до символа "/"')

        return v

    @model_validator(mode='after')
    def validate_service_note_consistency(self):
        """Проверяет что если указана служебная записка, то указана и дата"""
        if self.service_note and not self.service_note_date:
            raise ValueError('При указании служебной записки необходимо указать дату')

        if self.service_note_date and not self.service_note:
            raise ValueError('При указании даты служебной записки необходимо указать саму записку')

        return self

    @model_validator(mode='after')
    def validate_inspection_dates(self):
        """Проверяет что дата окончания проверки не раньше даты начала."""
        if (
            self.inspection_start_date
            and self.inspection_end_date
            and self.inspection_end_date < self.inspection_start_date
        ):
            raise ValueError(
                'Дата окончания проверки не может быть раньше даты начала'
            )
        return self

    @field_validator('audit_team')
    @classmethod
    def validate_audit_team_composition(cls, v):
        """Проверяет наличие минимум 1 куратора и 1 руководителя"""
        if not v:
            raise ValueError('Аудиторская группа не может быть пустой')

        curators = [m for m in v if m.role == 'Куратор']
        leaders = [m for m in v if m.role == 'Руководитель']

        if len(curators) < 1:
            raise ValueError('В аудиторской группе должен быть хотя бы один куратор')

        if len(leaders) < 1:
            raise ValueError('В аудиторской группе должен быть хотя бы один руководитель')

        return v


class ActUpdate(BaseModel):
    """Модель для обновления акта (все поля опциональны)"""
    km_number: Optional[str] = None
    part_number: Optional[int] = Field(default=None, ge=1)
    total_parts: Optional[int] = Field(default=None, ge=1)
    inspection_name: Optional[str] = None
    city: Optional[str] = None
    created_date: Optional[date] = None
    order_number: Optional[str] = None
    order_date: Optional[date] = None
    audit_team: Optional[List[AuditTeamMember]] = Field(default=None, min_length=1)
    inspection_start_date: Optional[date] = None
    inspection_end_date: Optional[date] = None
    is_process_based: Optional[bool] = None
    directives: Optional[List[ActDirective]] = None

    # Новые поля
    service_note: Optional[str] = None
    service_note_date: Optional[date] = None

    @field_validator('km_number')
    @classmethod
    def validate_km_number_format(cls, v):
        """Проверяет формат КМ: КМ-XX-XXXXX"""
        if v is None:
            return v

        pattern = r'^КМ-\d{2}-\d{5}$'
        if not re.match(pattern, v):
            raise ValueError(
                f'КМ номер должен быть в формате КМ-XX-XXXXX (например, КМ-99-94751), получено: {v}'
            )
        return v

    @field_validator('service_note')
    @classmethod
    def validate_service_note_format(cls, v):
        """Проверяет формат служебной записки: Текст/XXXX или принимает пустую строку как None для удаления"""
        # Пустая строка или None означает удаление СЗ
        if v is None or (isinstance(v, str) and v.strip() == ''):
            return None

        pattern = r'^.+/\d{4}$'
        if not re.match(pattern, v):
            raise ValueError(
                f'Служебная записка должна быть в формате Текст/XXXX '
                f'(например, ЦМ-75-вн/9475), получено: {v}'
            )

        parts = v.rsplit('/', 1)
        if len(parts[0].strip()) == 0:
            raise ValueError('Служебная записка должна содержать текст до символа "/"')

        return v

    @field_validator('audit_team')
    @classmethod
    def validate_audit_team_composition(cls, v):
        """Проверяет наличие минимум 1 куратора и 1 руководителя"""
        if v is None:
            return v

        if not v:
            raise ValueError('Аудиторская группа не может быть пустой')

        curators = [m for m in v if m.role == 'Куратор']
        leaders = [m for m in v if m.role == 'Руководитель']

        if len(curators) < 1:
            raise ValueError('В аудиторской группе должен быть хотя бы один куратор')

        if len(leaders) < 1:
            raise ValueError('В аудиторской группе должен быть хотя бы один руководитель')

        return v


class ActListItem(BaseModel):
    """Схема для списка актов пользователя."""

    id: int
    km_number: str
    part_number: int
    total_parts: int
    inspection_name: str
    order_number: str
    inspection_start_date: date
    inspection_end_date: date
    last_edited_at: Optional[datetime]
    user_role: str
    service_note: Optional[str] = None
    audit_act_id: Optional[str] = None
    # Статус блокировки
    locked_by: str | None = None
    is_locked: bool = False
    # Флаги валидации
    needs_created_date: bool = False
    needs_directive_number: bool = False
    needs_invoice_check: bool = False
    needs_service_note: bool = False
    # Состояние структурной валидации содержимого (вычисляется при сохранении).
    # validation_issues несём в список — карточка/колокольчик портала показывают
    # конкретику без загрузки полного содержимого акта.
    validation_status: str = "ok"
    validation_issues: list[dict] | None = None

    model_config = ConfigDict(from_attributes=True)


class ActAttentionItem(BaseModel):
    """Срез акта, требующего внимания (GET /api/v1/acts/attention-summary).

    Узкая схема для колокольчика лендинга: серверная сводка «мои акты, по
    которым нужно ещё поработать» (незакрытые требования фактура/СЗ/дата/
    поручения + структурная валидация содержимого). Поля совпадают по именам с
    подмножеством ActListItem, которое читает фронт-форматтер
    buildActsNotificationItems — клиент не пересчитывает статусы по сотне актов,
    а получает уже отфильтрованный список. Флаги needs_* поддерживаются ETL
    (приложение их только читает), validation_status пишется при сохранении.
    """

    id: int
    inspection_name: str
    needs_created_date: bool = False
    needs_directive_number: bool = False
    needs_invoice_check: bool = False
    needs_service_note: bool = False
    validation_status: str = "ok"
    validation_issues: list[dict] | None = None

    model_config = ConfigDict(from_attributes=True)


class ActResponse(BaseModel):
    """Полная информация об акте"""
    id: int
    km_number: str
    part_number: int
    total_parts: int
    inspection_name: str
    city: str
    created_date: Optional[date] = None
    order_number: str
    order_date: date
    is_process_based: bool
    inspection_start_date: date
    inspection_end_date: date
    audit_team: List[AuditTeamMember]
    directives: List[ActDirective]

    # Новые поля
    service_note: Optional[str] = None
    service_note_date: Optional[date] = None

    # Идентификатор аудита
    audit_act_id: Optional[str] = None

    # Служебные флаги валидации
    needs_created_date: bool = False
    needs_directive_number: bool = False
    needs_invoice_check: bool = False
    needs_service_note: bool = False
    # Состояние структурной валидации содержимого + конкретные замечания.
    validation_status: str = "ok"
    validation_issues: list[dict] | None = None

    created_at: datetime
    updated_at: datetime
    # Счётчик версий содержимого (optimistic-проверка PUT /content): фронт
    # берёт его из metadata и эхом возвращает в expected_content_version.
    # Инкрементируется только сохранением контента, метаданные не влияют.
    content_version: int = 0
    created_by: str
    last_edited_by: Optional[str]
    last_edited_at: Optional[datetime]


class AuditPointIdsRequest(BaseModel):
    """Запрос на генерацию audit_point_id для списка узлов."""
    node_ids: List[str] = Field(min_length=1)
