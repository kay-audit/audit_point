"""
DI-зависимости домена чата.

Предоставляет фабрики сервисов для использования в FastAPI Depends.
Сервисы строятся на исполнителе БД (``get_executor()``): соединение берётся
из пула на время одного SQL-вызова или одной явной транзакции, а не на весь
HTTP-запрос.
"""

from app.core.metrics_batcher import MetricsBatcher
from app.core.settings_registry import get as get_domain_settings
from app.db.executor import get_executor
from app.domains.chat.repositories.chat_audit_log_repository import (
    ChatAuditLogRecord,
    ChatAuditLogRepository,
)
from app.domains.chat.repositories.chat_tool_metrics_repository import (
    ChatToolMetricRecord,
    ChatToolMetricsRepository,
)
from app.domains.chat.repositories.chat_message_feedback_repository import (
    ChatMessageFeedbackRepository,
)
from app.domains.chat.repositories.conversation_repository import ConversationRepository
from app.domains.chat.repositories.file_repository import FileRepository
from app.domains.chat.repositories.message_repository import MessageRepository
from app.domains.chat.services.chat_analytics_service import ChatAnalyticsService
from app.domains.chat.services.chat_audit_service import ChatAuditService
from app.domains.chat.services.chat_feedback_service import ChatFeedbackService
from app.domains.chat.services.conversation_service import ConversationService
from app.domains.chat.services.file_service import FileService
from app.domains.chat.services.message_service import MessageService
from app.domains.chat.services.agent_channel import AgentChannelService
from app.domains.chat.services.agent_channel_poller import AgentChannelPoller
from app.domains.chat.services.user_rate_limiter import UserRateLimiter
from app.domains.chat.settings import ChatDomainSettings

# Singleton лимитера — создаётся при первом обращении, limit читается из settings.
# Lazy init: при смене настроек в тестах достаточно выставить _rate_limiter = None.
_rate_limiter: UserRateLimiter | None = None

# Батчеры метрик — инициализируются в lifespan приложения и используются
# оркестратором (tool-метрики) и audit-сервисом. None — fallback на синхронный
# путь (используется в тестах и при отключённом батчинге).
_tool_metrics_batcher: MetricsBatcher[ChatToolMetricRecord] | None = None
_audit_log_batcher: MetricsBatcher[ChatAuditLogRecord] | None = None


def set_tool_metrics_batcher(
    batcher: MetricsBatcher[ChatToolMetricRecord] | None,
) -> None:
    """Устанавливает (или сбрасывает) батчер tool-метрик. Зовётся из lifespan."""
    global _tool_metrics_batcher
    _tool_metrics_batcher = batcher


def get_tool_metrics_batcher() -> MetricsBatcher[ChatToolMetricRecord] | None:
    """Возвращает активный батчер tool-метрик (или None, если не инициализирован)."""
    return _tool_metrics_batcher


def set_audit_log_batcher(
    batcher: MetricsBatcher[ChatAuditLogRecord] | None,
) -> None:
    """Устанавливает (или сбрасывает) батчер audit-лога. Зовётся из lifespan."""
    global _audit_log_batcher
    _audit_log_batcher = batcher


def get_audit_log_batcher() -> MetricsBatcher[ChatAuditLogRecord] | None:
    """Возвращает активный батчер audit-лога (или None, если не инициализирован)."""
    return _audit_log_batcher


# Singleton поллера канала chat_agent_messages_bus — инициализируется в lifespan.
_agent_channel_poller: AgentChannelPoller | None = None


def set_agent_channel_poller(poller: AgentChannelPoller | None) -> None:
    """Устанавливает (или сбрасывает) AgentChannelPoller. Зовётся из lifespan."""
    global _agent_channel_poller
    _agent_channel_poller = poller


def get_agent_channel_poller() -> AgentChannelPoller | None:
    """Возвращает активный AgentChannelPoller (или None, если не инициализирован)."""
    return _agent_channel_poller


def get_chat_settings() -> ChatDomainSettings:
    """Возвращает настройки домена чата из реестра."""
    return get_domain_settings("chat", ChatDomainSettings)


def get_text_corrector_service():
    """DI-фабрика корректора (Фича «Корректор»). БД не требуется — чистый LLM-вызов."""
    from app.domains.chat.services.text_actions.corrector_service import (
        TextCorrectorService,
    )

    return TextCorrectorService(get_chat_settings())


def get_violation_formalizer_service():
    """DI-фабрика формализации нарушения (Фича «Формализация»). Чистый LLM-вызов."""
    from app.domains.chat.services.text_actions.formalizer_service import (
        ViolationFormalizerService,
    )

    return ViolationFormalizerService(get_chat_settings())


def get_rate_limiter() -> UserRateLimiter:
    """Возвращает singleton UserRateLimiter с лимитом из текущих настроек.

    Если домен chat не зарегистрирован в settings_registry (например, в тестах),
    создаёт лимитер с дефолтными значениями ChatDomainSettings.
    """
    global _rate_limiter
    if _rate_limiter is None:
        try:
            settings = get_chat_settings()
        except KeyError:
            settings = ChatDomainSettings()
        _rate_limiter = UserRateLimiter(
            limit=settings.rate_limit_messages_per_minute_per_user,
        )
    return _rate_limiter


def _make_audit_service() -> ChatAuditService:
    """ChatAuditService на исполнителе; батчер — актуальный из lifespan."""
    return ChatAuditService(
        repo=ChatAuditLogRepository(get_executor()),
        batcher=_audit_log_batcher,
    )


async def get_conversation_service() -> ConversationService:
    """Создаёт ConversationService на исполнителе БД (соединение на операцию)."""
    return ConversationService(
        conv_repo=ConversationRepository(get_executor()),
        settings=get_chat_settings(),
        audit_service=_make_audit_service(),
    )


async def get_message_service() -> MessageService:
    """Создаёт MessageService на исполнителе БД."""
    ex = get_executor()
    return MessageService(
        msg_repo=MessageRepository(ex),
        conv_repo=ConversationRepository(ex),
        settings=get_chat_settings(),
        audit_service=_make_audit_service(),
    )


async def get_file_service() -> FileService:
    """Создаёт FileService на исполнителе БД."""
    ex = get_executor()
    return FileService(
        file_repo=FileRepository(ex),
        conv_repo=ConversationRepository(ex),
        settings=get_chat_settings(),
        audit_service=_make_audit_service(),
    )


async def get_feedback_service() -> ChatFeedbackService:
    """Создаёт ChatFeedbackService на исполнителе БД."""
    return ChatFeedbackService(
        repo=ChatMessageFeedbackRepository(get_executor()),
        audit_service=_make_audit_service(),
    )


async def get_analytics_service() -> ChatAnalyticsService:
    """Создаёт ChatAnalyticsService (admin-аналитика чата) на исполнителе БД."""
    ex = get_executor()
    return ChatAnalyticsService(
        feedback_repo=ChatMessageFeedbackRepository(ex),
        msg_repo=MessageRepository(ex),
    )


def get_agent_channel_service() -> AgentChannelService:
    """Создаёт AgentChannelService на исполнителе БД.

    Синхронная сознательно: зовётся прямым вызовом из ``api/messages.py``
    (только в режиме ``always``), а не через ``Depends``.
    """
    return AgentChannelService(get_executor(), get_chat_settings())


def get_tool_metrics_repository() -> ChatToolMetricsRepository:
    """Создаёт ChatToolMetricsRepository на исполнителе БД.

    Синхронная сознательно: зовётся прямым вызовом из оркестратора,
    а не через ``Depends``.
    """
    return ChatToolMetricsRepository(get_executor())
