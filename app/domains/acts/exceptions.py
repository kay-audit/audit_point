"""Доменные исключения актов."""

from typing import ClassVar

from app.core.exceptions import AppError


class ActNotFoundError(AppError):
    """Акт или связанный ресурс не найден."""
    status_code = 404
    code: ClassVar[str] = "act-not-found"


class AccessDeniedError(AppError):
    """Пользователь не имеет доступа к акту."""
    status_code = 403
    code: ClassVar[str] = "access-denied"


class InsufficientRightsError(AppError):
    """Пользователь имеет доступ, но не имеет прав на данную операцию."""
    status_code = 403
    code: ClassVar[str] = "insufficient-rights"


class ActLockError(AppError):
    """Акт заблокирован другим пользователем или блокировка нарушена."""
    status_code = 409
    code: ClassVar[str] = "act-locked"

    def __init__(
        self,
        message: str,
        locked_by: str | None = None,
        locked_until: str | None = None,
    ) -> None:
        super().__init__(message)
        self.locked_by = locked_by
        self.locked_until = locked_until
        self.extra = {
            "locked_by": locked_by,
            "locked_until": locked_until,
        }


class ContentConflictError(AppError):
    """Содержимое акта изменено конкурентно (optimistic-проверка не прошла).

    Клиент прислал expected_content_version, не совпавший с текущим
    acts.content_version: с момента загрузки его состояния контент акта
    сохранил кто-то другой (вторая вкладка, перехват истёкшего лока).
    last_edited_at в extra — ISO-строка (для текста уведомления).
    """
    status_code = 409
    code: ClassVar[str] = "content-conflict"

    def __init__(
        self,
        message: str,
        current_content_version: int | None = None,
        last_edited_by: str | None = None,
        last_edited_at: str | None = None,
    ) -> None:
        super().__init__(message)
        self.extra = {
            "current_content_version": current_content_version,
            "last_edited_by": last_edited_by,
            "last_edited_at": last_edited_at,
        }


class KmConflictError(AppError):
    """Акт с таким КМ уже существует (конфликт уникальности)."""
    status_code = 409
    code: ClassVar[str] = "km-number-exists"

    def __init__(
        self,
        message: str,
        km_number: str | None = None,
        current_parts: int | None = None,
        next_part: int | None = None,
    ) -> None:
        super().__init__(message)
        self.km_number = km_number
        self.current_parts = current_parts
        self.next_part = next_part
        self.extra = {
            "km_number": km_number,
            "current_parts": current_parts,
            "next_part": next_part,
        }


class ActValidationError(AppError):
    """Ошибка бизнес-валидации данных акта."""
    status_code = 400
    code: ClassVar[str] = "act-validation"


class UnsupportedFormatError(AppError):
    """Запрошен неподдерживаемый формат экспорта."""
    status_code = 400
    code: ClassVar[str] = "act-unsupported-format"


class ActExportValidationError(AppError):
    """Ошибка бизнес-валидации при экспорте акта (например, превышена глубина дерева)."""
    status_code = 400
    code: ClassVar[str] = "act-export-validation"


class ActExportTimeoutError(AppError):
    """Операция экспорта акта превысила допустимое время ожидания."""
    status_code = 408
    code: ClassVar[str] = "act-export-timeout"


class ManagementRoleRequiredError(AppError):
    """Операция доступна только для Куратора или Руководителя."""
    status_code = 403
    code: ClassVar[str] = "act-management-role-required"


class InvoiceError(AppError):
    """Ошибка при работе с фактурой (неподдерживаемый тип БД и т.п.)."""
    status_code = 400
    code: ClassVar[str] = "act-invoice-error"


class ActImageValidationError(AppError):
    """Загружаемая картинка нарушения не прошла проверку формата или размера."""
    status_code = 422
    code: ClassVar[str] = "act-image-validation"


class ActImageNotFoundError(AppError):
    """Картинка нарушения не найдена (нет строки act_images у этого акта)."""
    status_code = 404
    code: ClassVar[str] = "act-image-not-found"
