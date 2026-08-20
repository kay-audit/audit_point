"""Настройки домена чата."""

from typing import Literal

from pydantic import BaseModel, Field, SecretStr, field_validator


class RetryPolicy(BaseModel):
    """Политика повторных попыток для transient-ошибок LLM-провайдера."""

    on_429: bool = True   # rate-limit (transient)
    on_5xx: bool = True   # server errors (transient)
    max_attempts: int = Field(default=5, ge=1)
    backoff_base_sec: float = Field(default=2.0, ge=0.0)
    # Отдельный кап для обрывов соединения (ConnectError/APIConnectionError/
    # PoolTimeout): сервер лёг — нет смысла ждать полный цикл из max_attempts,
    # быстро падаем на fallback. APITimeoutError («сервер медленный»)
    # сюда НЕ относится — он идёт по обычному max_attempts.
    connect_max_attempts: int = Field(default=2, ge=1)


class AgentChannelSettings(BaseModel):
    """Параметры канала к внешнему агенту через bus-таблицу chat_agent_messages_bus."""

    table_name: str = Field(default="chat_agent_messages_bus")
    # Схема БД bus-таблицы. Пусто → fallback на схему домена чата
    # (ChatDomainSettings.schema_name), затем на основную схему адаптера.
    # Позволяет вынести шину в общую integration-схему с внешним агентом.
    schema_name: str = Field(default="")
    poll_min_interval_sec: float = Field(default=2.0, gt=0.0)
    poll_max_interval_sec: float = Field(default=10.0, gt=0.0)
    poll_backoff_multiplier: float = Field(default=1.5, gt=1.0)
    # 30 минут: 3 ретрая NanoBot × (lease 300 + backoff 60) ≈ 1080 с + очередь.
    answer_timeout_sec: int = Field(default=1800, gt=0)
    # Таймаут взятия вопроса в работу: вопрос висит в 'pending' без движения
    # очереди дольше этого времени → черновик закрывается ошибкой. Idle-семантика:
    # движение очереди (см. poller) сбрасывает отсчёт.
    claim_timeout_sec: int = Field(default=1800, gt=0)  # 30 минут
    max_block_text_size: int = Field(default=262144, gt=0)
    # Максимальный размер ОДНОГО вложения, проходящего через шину (в обе
    # стороны). Входящее сверх лимита не материализуется — вместо файла
    # пользователь получает error-блок; исходящее пропускается с warning.
    max_media_file_size: int = Field(default=512 * 1024 * 1024, gt=0)


class LLMHealthProbeSettings(BaseModel):
    """Фоновая перепроверка доступности primary-LLM при открытом circuit breaker.

    Убирает «пробу живым запросом» из пути пользователя: пока primary лежит,
    все запросы мгновенно идут на fallback, а отдельная фоновая задача
    пингует primary с adaptive-backoff и закрывает breaker, как только
    primary отвечает (best-practice: Azure Architecture Center).
    """

    enabled: bool = True
    poll_min_interval_sec: float = Field(default=2.0, gt=0.0)
    poll_max_interval_sec: float = Field(default=30.0, gt=0.0)
    poll_backoff_multiplier: float = Field(default=1.5, gt=1.0)
    timeout_sec: float = Field(default=5.0, gt=0.0)


class TextActionsSettings(BaseModel):
    """Настройки фичи «Корректор»: два режима правки выделенного текста —
    орфография/пунктуация (``fix``) и улучшение читаемости/структуры
    (``readability``).

    Режим ``fix`` — перенос наработки D17 (папка 1). Дефолтная температура ниже
    исходной D17 (0.7) — корректору нужна детерминированность правок; при желании
    переопределяется через CHAT__TEXT_ACTIONS__CORRECTOR_TEMPERATURE. Режим
    ``readability`` — базовый (доработка команды D17).
    """

    # None → использовать основную модель профиля чата (ChatDomainSettings.model).
    # default_factory=lambda: None по той же причине, что fallback-поля ниже:
    # settings_registry делает поля с default=None обязательными.
    corrector_model: str | None = Field(default_factory=lambda: None)
    corrector_temperature: float = Field(default=0.1, ge=0.0, le=2.0)
    # Режим «улучшение читаемости»: чуть выше корректорской, чтобы
    # переструктурировать текст, но остаться верным фактам.
    readability_temperature: float = Field(default=0.3, ge=0.0, le=2.0)
    # Формализация нарушения (4 экстрактора D17): температура ~0 ради
    # детерминизма извлечения. None-модель → основная модель профиля чата.
    formalizer_model: str | None = Field(default_factory=lambda: None)
    formalizer_temperature: float = Field(default=0.01, ge=0.0, le=2.0)
    per_call_timeout_sec: float = Field(default=60.0, gt=0.0)
    max_input_chars: int = Field(default=20000, ge=1)


def parse_route(route: str) -> tuple[str, str]:
    """Разбирает маршрут LLM-профиля.

    Возвращает ``(transport, wire_format)``:
    transport — "http" (напрямую) | "redis" (через redis-bridge);
    wire_format — "openai" | "gigachat" (проводной формат тела запроса).

    Валидные маршруты: "gigachat", "openai",
    "redis-bridge,gigachat", "redis-bridge,openai".
    Имя цели после запятой совпадает с проводным форматом; какой сервер
    стоит за целью openai (sglang/vLLM/...), знает только воркер.
    """
    parts = [p.strip() for p in (route or "").split(",")]
    if len(parts) == 1 and parts[0] in ("gigachat", "openai"):
        return ("http", parts[0])
    if (
        len(parts) == 2
        and parts[0] == "redis-bridge"
        and parts[1] in ("gigachat", "openai")
    ):
        return ("redis", parts[1])
    raise ValueError(
        f"Неизвестный маршрут LLM-профиля: {route!r}. Допустимо: "
        "'gigachat', 'openai', 'redis-bridge,gigachat', 'redis-bridge,openai'."
    )


def wire_is_gigachat(route: str | None) -> bool:
    """True, если проводной формат маршрута — gigachat (нужны GigaChat-режимы)."""
    if not route:
        return False
    return parse_route(route)[1] == "gigachat"


class RedisBridgeSettings(BaseModel):
    """Настройки LLM-транспорта redis-bridge (env CHAT__REDIS_BRIDGE__*)."""

    key_prefix: str = "llm:bridge:"


class ChatDomainSettings(BaseModel):
    """Настройки AI-ассистента и чата."""

    # Маршрут LLM-провайдера: "gigachat" | "openai" |
    # "redis-bridge,gigachat" | "redis-bridge,openai" (см. parse_route).
    profile: str = "openai"
    extra_headers: dict[str, str] = Field(default_factory=dict)

    # LLM
    model: str = "gpt-4o"
    api_base: str = ""
    # Можно не хранить сам секрет в .env, а сослаться на переменную окружения:
    # CHAT__API_KEY=${JPY_API_TOKEN}. .env читается через python-dotenv (интерполяция
    # ${VAR} включена по умолчанию) → значение подставляется из окружения процесса.
    # Касается и fallback_api_key. Детали — developer-guide §9.4.1.
    api_key: SecretStr = SecretStr("")
    temperature: float = Field(default=0.1, ge=0.0, le=2.0)
    max_tool_rounds: int = Field(default=5, gt=0)
    request_timeout: int = Field(default=60, gt=0)

    # Fallback-провайдер на случай сбоя primary (circuit breaker).
    # Поля используют default_factory=lambda: None: settings_registry
    # пропускает поля с default=None при подъёме .env-loader'а, и они
    # становятся required (вместо желаемых Optional). default_factory
    # обходит эту особенность.
    fallback_profile: str | None = Field(
        default_factory=lambda: None,
        description=(
            "Маршрут провайдера для fallback при сбое primary "
            "(тот же формат, что profile). None = fallback отключён."
        ),
    )
    fallback_api_base: str | None = Field(default_factory=lambda: None)
    fallback_api_key: SecretStr | None = Field(default_factory=lambda: None)
    fallback_model: str | None = Field(default_factory=lambda: None)
    fallback_extra_headers: dict[str, str] = Field(default_factory=dict)

    circuit_breaker_failure_threshold: int = Field(
        default=2,
        ge=1,
        description=(
            "Подряд ошибок primary, после которого circuit размыкается"
        ),
    )
    circuit_breaker_recovery_timeout_sec: int = Field(
        default=60,
        ge=10,
        description=(
            "Сколько секунд circuit остаётся разомкнутым, "
            "пока probe не попробует primary"
        ),
    )

    # Поведение small-talk
    smalltalk_mode: Literal["local", "forward"] = "local"

    # Схема БД для собственных таблиц чата (conversations, messages, files,
    # tool_metrics, audit_log). Пусто → основная схема адаптера (GP) /
    # без квалификатора (PG). Учитывается и при создании, и при доступе.
    schema_name: str = ""

    # Retry-политика и канал к внешнему агенту через bus-таблицу
    retry: RetryPolicy = Field(default_factory=RetryPolicy)
    agent_channel: AgentChannelSettings = Field(default_factory=AgentChannelSettings)
    redis_bridge: RedisBridgeSettings = Field(default_factory=RedisBridgeSettings)
    health_probe: LLMHealthProbeSettings = Field(
        default_factory=LLMHealthProbeSettings,
    )
    text_actions: TextActionsSettings = Field(default_factory=TextActionsSettings)

    @field_validator("profile")
    @classmethod
    def _validate_profile(cls, v: str) -> str:
        parse_route(v)  # ValueError с понятным сообщением при мусоре
        return v

    @field_validator("fallback_profile")
    @classmethod
    def _validate_fallback_profile(cls, v: str | None) -> str | None:
        # Пустое значение ("CHAT__FALLBACK_PROFILE=" в .env) — документированный
        # способ отключить fallback: pydantic-settings передаёт "", не None.
        if v is None or not v.strip():
            return None
        parse_route(v)
        return v

    # Оркестрация
    system_prompt: str = (
        "Ты — AI-ассистент рабочей станции аудитора. "
        "Помогаешь с анализом актов, поиском информации и ответами на вопросы. "
        "Отвечай на русском языке, кратко и по делу."
    )
    max_history_length: int = Field(default=50, gt=0)
    max_message_content_length: int = Field(default=10000, gt=0)
    tool_execution_timeout: int = Field(default=30, gt=0)
    # Количество последних сообщений истории с полным контентом (включая file/image-блоки).
    # Более старые сообщения получают placeholder вместо бинарного контента.
    history_full_context_depth: int = Field(default=5, ge=1)

    # Файлы
    # Потолок согласован с шиной агента (AgentChannelSettings.max_media_file_size):
    # файл, который пользователь может отправить агенту, должен пройти и обратно.
    max_file_size: int = Field(default=512 * 1024 * 1024, gt=0)
    # Жёсткий whitelist точных MIME-типов (БЕЗ подстановок). Сравнение
    # производится посимвольно — браузерные "text/html; charset=utf-8"
    # отклоняются, что блокирует попытки залить HTML под видом текста.
    allowed_mime_types: list[str] = [
        "text/plain",
        "text/csv",
        "text/markdown",
        "application/pdf",
        "application/json",
        "application/xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
    ]
    max_files_per_message: int = Field(default=5, gt=0)
    # Тот же потолок, что и на одиночный файл: суммарный размер вложений
    # сообщения не должен резать то, что шина агента пропускает поштучно.
    max_total_file_size: int = Field(default=512 * 1024 * 1024, gt=0)

    @field_validator("allowed_mime_types")
    @classmethod
    def _no_wildcards_in_mime_types(cls, v: list[str]) -> list[str]:
        """Запрещает подстановки и пустые элементы в whitelist."""
        for item in v:
            if not item or not item.strip():
                raise ValueError(
                    "allowed_mime_types: пустой элемент недопустим",
                )
            if "*" in item:
                raise ValueError(
                    f"allowed_mime_types: подстановки запрещены ('{item}'). "
                    "Используй точные MIME-типы.",
                )
        return v

    # Per-user rate limit на отправку сообщений
    rate_limit_messages_per_minute_per_user: int = Field(default=10, ge=1)

    # Максимум одновременных активных запросов к агенту на одного
    # пользователя. При превышении submit бросает ChatLimitError → HTTP 422.
    max_parallel_streams_per_user: int = Field(default=3, ge=1, le=20)

    # Хранение
    max_conversations_per_user: int = Field(default=100, gt=0)
    max_messages_per_conversation: int = Field(default=500, gt=0)


def resolve_chat_schema() -> str:
    """Схема собственных таблиц чата. Пусто → основная схема адаптера.

    Безопасно при незарегистрированном домене (юнит-тесты): вернёт "".
    """
    from app.core.settings_registry import get

    try:
        return get("chat", ChatDomainSettings).schema_name
    except KeyError:
        return ""


def resolve_bus_schema() -> str:
    """Схема bus-таблицы: agent_channel.schema_name → схема чата → основная."""
    from app.core.settings_registry import get

    try:
        s = get("chat", ChatDomainSettings)
    except KeyError:
        return ""
    return s.agent_channel.schema_name or s.schema_name


def resolve_bus_table() -> str:
    """Имя bus-таблицы из настройки agent_channel.table_name.

    Подставляется в миграции как {BUS_TABLE}. К имени НЕ добавляется префикс
    приложения — шина общая с внешним агентом, её имя задаётся настройкой
    целиком. Безопасно при незарегистрированном домене (юнит-тесты): вернёт
    дефолтное имя.
    """
    from app.core.settings_registry import get

    try:
        return get("chat", ChatDomainSettings).agent_channel.table_name
    except KeyError:
        return "chat_agent_messages_bus"


def schema_qualifier(domain_schema: str) -> str:
    """Квалификатор '<schema>.' для подстановки в миграции.

    Пустая доменная схема воспроизводит дефолтное поведение адаптера:
    основная схема GP (`<main>.`) либо без квалификатора на PG (``).
    """
    if domain_schema:
        return f"{domain_schema}."
    from app.db.connection import get_adapter

    main = getattr(get_adapter(), "schema", "")
    return f"{main}." if main else ""
