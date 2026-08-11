"""Доменные исключения чата."""

from typing import ClassVar

from app.core.exceptions import AppError


class ConversationNotFoundError(AppError):
    """Беседа не найдена."""
    status_code = 404
    code: ClassVar[str] = "conversation-not-found"


class ChatMessageNotFoundError(AppError):
    """Сообщение чата не найдено."""
    status_code = 404
    code: ClassVar[str] = "chat-message-not-found"


class ChatFileNotFoundError(AppError):
    """Файл чата не найден."""
    status_code = 404
    code: ClassVar[str] = "chat-file-not-found"


class ChatLimitError(AppError):
    """Превышен лимит (бесед, сообщений и т.д.)."""
    status_code = 422
    code: ClassVar[str] = "chat-limit-exceeded"


class ChatFileValidationError(AppError):
    """Файл не проходит валидацию (размер, тип)."""
    status_code = 422
    code: ClassVar[str] = "chat-file-validation"


class ChatFeedbackValidationError(AppError):
    """Оценка сообщения не проходит валидацию.

    Например: rating не из набора ('up'/'down'), неизвестный код причины
    дизлайка, слишком длинный комментарий, или сообщение нельзя оценивать
    (не assistant-роль).
    """
    status_code = 422
    code: ClassVar[str] = "chat-feedback-validation"


class ChatLLMUnavailableError(AppError):
    """Ни один маршрут LLM не доступен — запрос даже не отправлялся.

    Бросается планировщиком маршрутов (``llm_routing.plan_routes`` →
    ``llm_call``), когда ни primary, ни fallback не прошли проверку
    доступности: например, ``CHAT__PROFILE=redis-bridge,gigachat``, а воркер
    на DataLab не запущен. Отличается от «провайдер ответил ошибкой»: там
    были реальные попытки, ретраи и circuit breaker, здесь пробовать нечего.

    Техническая причина по каждому маршруту уходит в лог; пользователю —
    только нейтральный текст.
    """
    status_code = 503
    code: ClassVar[str] = "chat-llm-unavailable"


class AgentChannelUnavailableError(AppError):
    """Канал к внешнему агенту отклонил запрос.

    Бросается, когда INSERT вопроса в bus-таблицу отклонён констрейнтом
    владельца шины (имя его CHECK'а на ПРОМе чужое — глобальный маппинг
    CHECK_CONSTRAINT_MESSAGES его не знает, и без этой ошибки пользователь
    увидел бы технический fallback вместо понятного сообщения).
    """
    status_code = 502
    code: ClassVar[str] = "chat-agent-channel-unavailable"


class ChatToolValidationError(AppError):
    """Вызов ChatTool не прошёл валидацию (например, отсутствует
    обязательный параметр)."""
    status_code = 400
    code: ClassVar[str] = "chat-tool-validation"


class ConversationLockedError(AppError):
    """Беседа заблокирована активной генерацией ответа и не может быть изменена.

    Бросается при попытке удалить беседу пользователя, у которого
    в данный момент идёт генерация ответа ассистента — иначе фоновая
    задача продолжит писать сообщения в уже удалённую беседу.
    """
    status_code = 409
    code: ClassVar[str] = "conversation-locked"


class OptimisticLockFailed(AppError):
    """Optimistic locking конфликт при финализации записи под версионным апдейтом.

    Бросается, когда finalize обнаруживает, что версия строки уже изменена
    другим воркером. Транзакция откатывается, статус не меняется.
    """
    status_code = 409
    code: ClassVar[str] = "chat-optimistic-lock-failed"


class ChatRateLimitError(AppError):
    """Превышен per-user rate-limit на отправку сообщений.

    Бросается, когда пользователь превышает лимит сообщений за скользящее
    окно 60 секунд (настраивается через CHAT__RATE_LIMIT_MESSAGES_PER_MINUTE_PER_USER).
    """
    status_code = 429
    code: ClassVar[str] = "chat-rate-limit"

    def __init__(self, message: str, retry_after_sec: int = 60) -> None:
        super().__init__(message)
        self.retry_after_sec = retry_after_sec
        self.extra = {"retry_after_sec": retry_after_sec}


class TextActionValidationError(AppError):
    """Текст для text-action не проходит валидацию (пустой или слишком длинный)."""
    status_code = 422
    code: ClassVar[str] = "text-action-validation"
